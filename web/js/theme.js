(function () {
  const storageKey = "chat-theme";
  const media = window.matchMedia("(prefers-color-scheme: light)");
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches
    || navigator.standalone === true;
  const isAppStart = location.pathname === "/" || location.pathname === "/index.html";
  if (isIOS && isStandalone && isAppStart) {
    const splashSymbolSize = 120;
    const viewportSize = () => ({
      width: window.visualViewport?.width || window.innerWidth,
      height: window.visualViewport?.height || window.innerHeight,
    });
    const screenSizeForViewport = (viewportWidth, viewportHeight) => {
      let width = window.screen.width || viewportWidth;
      let height = window.screen.height || viewportHeight;
      // iPadOS can keep screen.width/screen.height in their portrait order
      // after a PWA has started in landscape. Match them to the live viewport.
      const viewportIsLandscape = viewportWidth > viewportHeight;
      const screenIsLandscape = width > height;
      if (viewportIsLandscape !== screenIsLandscape) [width, height] = [height, width];
      return { width, height };
    };
    const applyStartupScreenSize = (viewportWidth, viewportHeight) => {
      const screenSize = screenSizeForViewport(viewportWidth, viewportHeight);
      document.documentElement.style.setProperty("--startup-screen-width", `${screenSize.width}px`);
      document.documentElement.style.setProperty("--startup-screen-height", `${screenSize.height}px`);
      document.documentElement.style.setProperty(
        "--startup-symbol-x",
        `${(screenSize.width - splashSymbolSize) / 2}px`,
      );
      return screenSize;
    };
    const initialViewport = viewportSize();
    applyStartupScreenSize(initialViewport.width, initialViewport.height);
    document.documentElement.classList.add("ios-pwa-starting");

    let previousViewport = null;
    let measurementCount = 0;
    const positionStartupSymbol = () => {
      const viewport = viewportSize();
      measurementCount++;
      const viewportIsStable = previousViewport !== null
        && Math.abs(viewport.width - previousViewport.width) < 0.5
        && Math.abs(viewport.height - previousViewport.height) < 0.5;
      if (!viewportIsStable && measurementCount < 6) {
        previousViewport = viewport;
        requestAnimationFrame(positionStartupSymbol);
        return;
      }
      const screenSize = applyStartupScreenSize(viewport.width, viewport.height);
      const pageTopOffset = Math.max(0, screenSize.height - viewport.height);
      document.documentElement.style.setProperty(
        "--startup-symbol-y",
        `${(screenSize.height - splashSymbolSize) / 2 - pageTopOffset}px`,
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
    // Recreate the media query when the app resumes: an installed iPad PWA can
    // be suspended while iPadOS changes appearance, leaving the original
    // MediaQueryList event (and sometimes its cached state) behind.
    const systemIsLight = window.matchMedia("(prefers-color-scheme: light)").matches;
    const resolved = value === "auto" ? (systemIsLight ? "light" : "dark") : value;
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

  const refreshAutomaticTheme = () => {
    if (preference() === "auto") apply("auto");
  };
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", refreshAutomaticTheme);
  } else if (typeof media.addListener === "function") {
    // iPadOS 13 and older Safari versions expose the legacy MediaQueryList API.
    media.addListener(refreshAutomaticTheme);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshAutomaticTheme();
  });
  window.addEventListener("pageshow", refreshAutomaticTheme);
  window.addEventListener("focus", refreshAutomaticTheme);
  window.addEventListener("storage", (event) => {
    if (event.key === storageKey) apply();
  });
  apply();
}());
