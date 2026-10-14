const isPlainRecord = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const constructor = value.constructor;
    if (constructor === undefined || typeof constructor !== "function") return true;
    const prototype = constructor.prototype;
    return (
      typeof prototype === "object" &&
      prototype !== null &&
      Object.prototype.hasOwnProperty.call(prototype, "isPrototypeOf")
    );
  } catch {
    return false;
  }
};

const copy = (credentials) => {
  if (!isPlainRecord(credentials)) {
    throw new TypeError("Secure credentials must be a plain record");
  }
  const document = {};
  for (const key of Reflect.ownKeys(credentials)) {
    if (!Object.prototype.propertyIsEnumerable.call(credentials, key)) continue;
    if (typeof key !== "string") {
      throw new TypeError("Secure credential keys must be strings");
    }
    if (key === "__proto__") continue;
    document[key] = credentials[key];
  }
  return structuredClone(document);
};

export function createSecureCredentialState(initialCredentials, persist, { writable = true, reload, afterReload } = {}) {
  let current = copy(initialCredentials);
  let transition = Promise.resolve();

  const recover = async () => {
    if (writable) return true;
    if (!reload) return false;
    const result = await reload();
    if (result.status !== "ok") return false;
    const restored = copy(result.credentials);
    await afterReload?.(copy(restored));
    current = restored;
    writable = true;
    return true;
  };

  const serialize = (work) => {
    const next = transition.then(work, work);
    transition = next.then(
      () => {},
      () => {},
    );
    return next;
  };

  return {
    read() {
      return copy(current);
    },

    retry() {
      return serialize(recover);
    },

    update(derive, afterPersist) {
      return serialize(async () => {
        if (!(await recover())) {
          throw new Error("The credential store is locked. Unlock your keychain and try again. Your saved keys have not been changed.");
        }
        const previous = copy(current);
        const next = copy(await derive(copy(previous)));
        await persist(copy(next));
        try {
          const result = await afterPersist?.(copy(next));
          current = next;
          return result ?? copy(next);
        } catch (error) {
          await persist(copy(previous));
          current = previous;
          throw error;
        }
      });
    },
  };
}
