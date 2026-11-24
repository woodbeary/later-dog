const face = document.querySelector(".face");
const name = document.querySelector(".name");
const step = document.querySelector(".step");
const stop = document.querySelector(".stop");

window.presence.onState(state => {
  if (!state) {
    document.body.dataset.shown = "false";
    return;
  }
  face.textContent = [...state.name.trim()][0]?.toUpperCase() ?? "";
  name.textContent = state.name;
  step.textContent = state.step;
  stop.setAttribute("aria-label", `Stop ${state.name}`);
  document.body.dataset.shown = "true";
});

stop.addEventListener("mouseenter", () => window.presence.hover(true));
stop.addEventListener("mouseleave", () => window.presence.hover(false));
stop.addEventListener("click", () => window.presence.stop());
