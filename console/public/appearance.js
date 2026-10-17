// Apply saved appearance before the first stylesheet paints. No credentials are read.
(() => {
  try {
    const theme = localStorage.getItem("mini-archipel.theme");
    const dark =
      theme === "dark" ||
      (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  } catch {
    /* CSS follows the system when storage is unavailable. */
  }
})();
