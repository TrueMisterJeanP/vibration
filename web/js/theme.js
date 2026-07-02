(function () {
  const storageKey = "chat-theme";
  const media = window.matchMedia("(prefers-color-scheme: light)");

  function preference() {
    const saved = localStorage.getItem(storageKey);
    return saved === "light" || saved === "dark" ? saved : "auto";
  }

  function apply(value = preference()) {
    const resolved = value === "auto" ? (media.matches ? "light" : "dark") : value;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = resolved === "light" ? "#f3f7f7" : "#0f766e";
  }

  window.ChatTheme = {
    getPreference: preference,
    setPreference(value) {
      const normalized = value === "light" || value === "dark" ? value : "auto";
      localStorage.setItem(storageKey, normalized);
      apply(normalized);
    },
  };

  media.addEventListener("change", () => {
    if (preference() === "auto") apply("auto");
  });
  window.addEventListener("storage", (event) => {
    if (event.key === storageKey) apply();
  });
  apply();
}());
