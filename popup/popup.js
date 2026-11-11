const reason = new URLSearchParams(location.search).get("motivo");
const open = document.getElementById("open");

if (reason === "recargar") {
  document.getElementById("title").textContent = "No he podido abrir el panel";
  document.getElementById("text").textContent = "Recarga la página del portal y vuelve a pulsar el icono.";
  open.textContent = "Recargar la página";
  open.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) await chrome.tabs.reload(tab.id);
    window.close();
  });
} else {
  open.addEventListener("click", async () => {
    await chrome.tabs.create({ url: "https://aplicaciones.aragon.es/fct/" });
    window.close();
  });
}
