(function () {
  if (window.__cuadernoPageHooks) return;
  window.__cuadernoPageHooks = true;
  const originalAlert = window.alert;
  const originalConfirm = window.confirm;
  // Corre en el mundo de la página: el script de contenido no puede sustituir alert() desde el suyo
  // y solo comparte el DOM, así que la señal va por atributos de <html>.
  const hooked = () => document.documentElement && document.documentElement.dataset.cuadernoHook === "1";

  window.alert = function (message) {
    if (!hooked()) return originalAlert.apply(this, arguments);
    document.documentElement.dataset.cuadernoAlert = String(message ?? "");
  };

  window.confirm = function () {
    if (!hooked()) return originalConfirm.apply(this, arguments);
    return true;
  };

  // Vuelve al formulario de Nueva recargando el listado como lo hace el propio portal.
  document.addEventListener("cuaderno-reset-form", () => {
    if (typeof window.paginar !== "function") return;
    const value = (id) => (document.getElementById(id) || {}).value || "";
    const editing = document.getElementById("ID_DESARROLLO_SEM");
    if (editing) editing.value = "0";
    window.paginar(value("campoordenacion") || "fecha", value("tipoordenacion") || "ASC", value("pagina") || "0");
  });
})();
