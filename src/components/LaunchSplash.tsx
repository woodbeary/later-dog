import { useEffect, useState } from "react";
import { BreedAvatar } from "@/components/DogAvatar";
import { DEFAULT_DOG_COLOR } from "@/lib/mascot";
import { useStoreSelector } from "@/state/store-selectors";

export function LaunchSplash() {
  const ready = useStoreSelector((state) => state.restored === true || state.hydrated === true);
  const [finished, setFinished] = useState(ready);

  useEffect(() => {
    if (ready) setFinished(true);
  }, [ready]);

  if (ready || finished) return null;
  return (
    <div
      data-launch-splash="shown"
      aria-hidden="true"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-app"
    >
      <BreedAvatar breed="dog" color={DEFAULT_DOG_COLOR} size={72} />
    </div>
  );
}
