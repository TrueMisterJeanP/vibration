(function () {
  const storageKey = "chat-theme";
  const media = window.matchMedia("(prefers-color-scheme: light)");
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches
    || navigator.standalone === true;
  const isAppStart = location.pathname === "/" || location.pathname === "/index.html";
  if (isIOS && isStandalone && isAppStart) {
    const screenWidth = window.screen.width || window.innerWidth;
    const screenHeight = window.screen.height || window.innerHeight;
    const splashSymbolSize = 120;
    document.documentElement.style.setProperty("--startup-screen-width", `${screenWidth}px`);
    document.documentElement.style.setProperty("--startup-screen-height", `${screenHeight}px`);
    document.documentElement.style.setProperty("--startup-symbol-x", `${(screenWidth - splashSymbolSize) / 2}px`);
    document.documentElement.classList.add("ios-pwa-starting");

    let previousViewportHeight = null;
    let measurementCount = 0;
    const positionStartupSymbol = () => {
      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      measurementCount++;
      const heightIsStable = previousViewportHeight !== null
        && Math.abs(viewportHeight - previousViewportHeight) < 0.5;
      if (!heightIsStable && measurementCount < 6) {
        previousViewportHeight = viewportHeight;
        requestAnimationFrame(positionStartupSymbol);
        return;
      }
      const pageTopOffset = Math.max(0, screenHeight - viewportHeight);
      document.documentElement.style.setProperty(
        "--startup-symbol-y",
        `${(screenHeight - splashSymbolSize) / 2 - pageTopOffset}px`,
      );
      document.documentElement.classList.add("ios-pwa-splash-positioned");
    };
    requestAnimationFrame(positionStartupSymbol);
  }
  function preference() {
    const saved = localStorage.getItem(storageKey);
    return saved === "light" || saved === "dark" ? saved : "auto";
  }

  function apply(value = preference()) {
    const resolved = value === "auto" ? (media.matches ? "light" : "dark") : value;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) {
      const startupColor = resolved === "light" ? "#c9e7e4" : "#1b5260";
      themeColor.content = document.documentElement.classList.contains("ios-pwa-starting")
        ? startupColor
        : resolved === "light" ? "#c9e7e4" : "#0f766e";
    }
  }

  window.ChatTheme = {
    getPreference: preference,
    refresh: apply,
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
