import { updateErrorMessage, updateErrorNeedsPerson, updateNotPublished } from "./update-errors.mjs";
import { updateNotes } from "./update-feed.mjs";

const NATIVE_STAGING_DEADLINE_MS = 5 * 60 * 1000;
const RESTART_WATCHDOG_MS = 2 * 60 * 1000;

export function createUpdaterCoordinator(updater, setState, { handOffInstall = null, nativeStaging = false, receipt = null } = {}) {
  let checkOperation = null;
  let downloadedFiles = null;
  let downloadedVersion = null;
  let downloadOperation = null;
  let installOperation = null;
  let nativeStagingStarted = false;
  let recoveryRequired = false;
  let actionOwnsState = false;
  const routedErrors = new WeakSet();

  const routeError = (manual, error) => {
    if (recoveryRequired) return;
    const shown = (manual && !updateNotPublished(error)) || updateErrorNeedsPerson(error);
    actionOwnsState = shown;
    if (error instanceof Error) routedErrors.add(error);
    if (downloadOperation) downloadOperation.failed = true;
    if (checkOperation) checkOperation.failed = true;
    if (installOperation) {
      installOperation.failed = true;
      clearTimeout(installOperation.timer);
      installOperation.stopWaiting?.();
      if (installOperation.restarting) receipt?.clear();
      installOperation = null;
    }
    if (nativeStagingStarted) {
      recoveryRequired = true;
      downloadedVersion = null;
      setState({
        status: "error",
        retryable: false,
        message: `${updateErrorMessage(error)} Quit and reopen later.dog before trying the update again.`,
      });
      return;
    }
    if (!shown) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "error", message: updateErrorMessage(error) });
  };

  function handleRejectedOperation(manual, error) {
    if (error instanceof Error && routedErrors.has(error)) return;
    routeError(manual, error);
  }

  function checkOwnsState() {
    return !recoveryRequired && !actionOwnsState && !installOperation && !downloadOperation && !checkOperation?.supersededByDownload;
  }

  updater.on("checking-for-update", () => {
    if (checkOwnsState()) setState({ status: "checking" });
  });
  updater.on("update-available", (info) => {
    if (checkOwnsState()) {
      download(Boolean(checkOperation?.manual), { version: info?.version, notes: updateNotes(info), percent: undefined, message: undefined });
    }
  });
  updater.on("update-not-available", () => {
    if (!checkOwnsState()) return;
    downloadedVersion = null;
    setState({ status: "idle" });
  });
  updater.on("error", (error) => {
    if (checkOperation?.supersededByDownload && !installOperation) return;
    const manual = Boolean(installOperation || downloadOperation?.manual || checkOperation?.manual || nativeStagingStarted);
    routeError(manual, error);
  });
  updater.on("download-progress", (progress) => {
    if (recoveryRequired || installOperation || nativeStagingStarted) return;
    setState({ status: "downloading", percent: Math.round(progress?.percent ?? 0) });
  });
  updater.on("update-downloaded", (info) => {
    if (recoveryRequired || installOperation || nativeStagingStarted) return;
    if (downloadOperation) {
      downloadOperation.downloadedInfo = info;
      return;
    }
    actionOwnsState = true;
    downloadedVersion = info?.version ?? null;
    setState({ status: "downloaded", version: info?.version });
  });

  function check(manual = false) {
    if (manual && downloadOperation) downloadOperation.manual = true;
    if (recoveryRequired || installOperation || (nativeStaging && (downloadOperation || nativeStagingStarted)) || (!manual && actionOwnsState)) return Promise.resolve();
    if (checkOperation) {
      if (manual) checkOperation.manual = true;
      return checkOperation.promise;
    }

    if (manual) actionOwnsState = false;
    const operation = { manual, supersededByDownload: Boolean(downloadOperation), failed: false, promise: null };
    checkOperation = operation;
    try {
      operation.promise = Promise.resolve(updater.checkForUpdates())
        .catch((error) => {
          if (!operation.supersededByDownload) handleRejectedOperation(operation.manual, error);
        })
        .finally(() => {
          if (checkOperation === operation) checkOperation = null;
        });
    } catch (error) {
      if (!operation.supersededByDownload) handleRejectedOperation(operation.manual, error);
      checkOperation = null;
      operation.promise = Promise.resolve();
    }
    return operation.promise;
  }

  function download(manual, starting) {
    if (recoveryRequired || installOperation || nativeStagingStarted) return;
    if (checkOperation) checkOperation.supersededByDownload = true;

    const operation = { downloadedInfo: null, failed: false, manual };
    downloadOperation = operation;
    downloadedVersion = null;
    setState({ status: "downloading", ...starting });
    try {
      void Promise.resolve(updater.downloadUpdate())
        .then((result) => {
          if (!operation.failed) {
            downloadedFiles = Array.isArray(result) ? result.filter((file) => typeof file === "string") : null;
          }
          if (!operation.failed && operation.downloadedInfo) {
            downloadedVersion = operation.downloadedInfo?.version ?? null;
            actionOwnsState = true;
            setState({ status: "downloaded", version: operation.downloadedInfo?.version });
          }
        })
        .catch((error) => handleRejectedOperation(operation.manual, error))
        .finally(() => {
          if (downloadOperation === operation) downloadOperation = null;
        });
    } catch (error) {
      handleRejectedOperation(operation.manual, error);
      downloadOperation = null;
    }
  }

  function install(version) {
    if (recoveryRequired || installOperation || downloadOperation || !downloadedVersion) return;
    if (version !== downloadedVersion) {
      updater.logger?.warn?.(`Update install for ${version ?? "an unnamed version"} refused: ${downloadedVersion} is the one downloaded.`);
      setState({});
      return;
    }
    actionOwnsState = true;
    if (handOffInstall) {
      handOff();
      return;
    }
    const operation = { failed: false, timer: null, restarting: false, stopWaiting: null };
    installOperation = operation;
    if (nativeStaging) {
      stageNatively(operation);
      return;
    }
    restart(operation);
  }

  function stageNatively(operation) {
    const native = updater.nativeUpdater;
    nativeStagingStarted = true;
    setState({ status: "preparing", message: undefined });
    const staged = () => {
      if (installOperation !== operation || operation.failed) return;
      operation.stopWaiting = null;
      clearTimeout(operation.timer);
      restart(operation);
    };
    operation.stopWaiting = () => native?.removeListener?.("update-downloaded", staged);
    operation.timer = setTimeout(() => {
      updater.logger?.warn?.("Native update preparation exceeded the five-minute deadline; restart is required before retrying.");
      routeError(true, new Error("Preparing the update took too long."));
    }, NATIVE_STAGING_DEADLINE_MS);
    operation.timer.unref?.();
    try {
      native.once("update-downloaded", staged);
      native.checkForUpdates();
    } catch (error) {
      routeError(true, error);
    }
  }

  function restart(operation) {
    operation.restarting = true;
    receipt?.write(downloadedVersion);
    setState({ status: "installing" });
    try {
      updater.quitAndInstall(true, true);
    } catch (error) {
      routeError(true, error);
      return;
    }
    if (installOperation === operation) {
      operation.timer = setTimeout(() => {
        if (installOperation !== operation) return;
        updater.logger?.warn?.("Update restart handoff exceeded two minutes; keeping installation locked to prevent overlapping retries.");
        setState({ status: "installing", message: "Restart is taking longer than expected. Quit and reopen later.dog to finish the update." });
      }, RESTART_WATCHDOG_MS);
      operation.timer.unref?.();
    }
  }

  function handOff() {
    const operation = { failed: false, timer: null };
    installOperation = operation;
    setState({ status: "installing" });
    Promise.resolve()
      .then(() => handOffInstall(downloadedFiles))
      .then((patch) => {
        if (installOperation !== operation) return;
        installOperation = null;
        setState({ status: "handed-off", ...patch });
      })
      .catch((error) => {
        if (installOperation !== operation) return;
        routeError(true, error);
      });
  }

  return { check, install };
}
