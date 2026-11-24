window.presence.onState(state => {
  document.body.dataset.shown = state?.screen ? "true" : "false";
});
