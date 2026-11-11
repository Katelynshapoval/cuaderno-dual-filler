let queue = Promise.resolve();

function enqueue(task) {
  queue = queue.then(task).catch((error) => {
    console.error(error);
  });
  return queue;
}

function badgeFor(run) {
  if (!run || run.status === "idle") {
    return { text: "", color: "#36415a", title: "Cuaderno Dual" };
  }
  if (run.status === "error") {
    return { text: "!", color: "#c2362f", title: run.error || "El rellenado se ha detenido" };
  }
  if (run.status === "paused") {
    const left = Math.max((run.entries?.length || 0) - (run.index || 0), 0);
    return { text: String(left), color: "#b7791f", title: `${left} días restantes, en pausa` };
  }
  if (run.status === "done") {
    return { text: "OK", color: "#4c7a2c", title: "Días guardados" };
  }
  const left = Math.max((run.entries?.length || 0) - (run.index || 0), 0);
  const current = run.entries?.[run.index]?.fecha || "";
  return {
    text: String(left),
    color: "#36415a",
    title: current ? `${left} restantes · guardando ${current}` : `${left} días restantes`,
  };
}

async function refreshBadge() {
  try {
    const { run } = await chrome.storage.local.get("run");
    const badge = badgeFor(run);
    await chrome.action.setBadgeText({ text: badge.text });
    await chrome.action.setBadgeBackgroundColor({ color: badge.color });
    await chrome.action.setTitle({ title: badge.title });
  } catch (error) {
    console.error(error);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  refreshBadge();
});

chrome.runtime.onStartup.addListener(() => {
  refreshBadge();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.run) refreshBadge();
});

const PORTAL = "https://aplicaciones.aragon.es/";

function isPortal(url) {
  return Boolean(url && url.startsWith(PORTAL));
}

// Fuera del portal el clic no tiene nada que abrir: se enseña un aviso en su lugar.
// Ese popup queda fijado a la pestaña hasta que vuelva al portal (ver tabs.onUpdated).
async function showNotice(tabId, reason) {
  const popup = reason ? `popup/popup.html?motivo=${reason}` : "popup/popup.html";
  await chrome.action.setPopup({ tabId, popup });
  try {
    await chrome.action.openPopup();
  } catch (error) {
    // Chrome antiguo: el aviso saldrá en el siguiente clic.
  }
  if (reason) await chrome.action.setPopup({ tabId, popup: "" });
}

async function togglePanel(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "TOGGLE_PANEL" });
    return;
  } catch (error) {
    // Pestaña abierta antes de instalar o recargar la extensión: no tiene los scripts.
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/page-hooks.js"],
    world: "MAIN",
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["shared/plan.js", "shared/calendar.js", "panel/panel.js", "content/content.js"],
  });
  await chrome.tabs.sendMessage(tabId, { type: "TOGGLE_PANEL" });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  if (!isPortal(tab.url)) {
    await showNotice(tab.id).catch(console.error);
    return;
  }
  try {
    await togglePanel(tab.id);
  } catch (error) {
    await showNotice(tab.id, "recargar").catch(console.error);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (isPortal(changeInfo.url)) chrome.action.setPopup({ tabId, popup: "" }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  if (message.type === "WHOAMI") {
    sendResponse({ tabId: sender.tab ? sender.tab.id : null });
    return;
  }

  if (message.type === "RELEASE") {
    enqueue(async () => {
      const { run } = await chrome.storage.local.get("run");
      if (!run || run.owner !== message.frame) return;
      await chrome.storage.local.set({
        run: { ...run, owner: null, phase: run.phase === "working" ? "idle" : run.phase },
      });
    });
    return;
  }

  if (message.type === "CLAIM") {
    enqueue(async () => {
      const { run } = await chrome.storage.local.get("run");
      const tabId = sender.tab ? sender.tab.id : null;
      if (!run || run.status !== "running" || run.index !== message.index) {
        sendResponse({ ok: false });
        return;
      }
      if (run.tabId != null && tabId != null && run.tabId !== tabId) {
        sendResponse({ ok: false });
        return;
      }
      const held =
        run.owner &&
        run.owner !== message.frame &&
        run.ownerIndex === message.index &&
        Date.now() - (run.ownedAt || 0) < 5000;
      if (held) {
        sendResponse({ ok: false });
        return;
      }
      await chrome.storage.local.set({
        run: {
          ...run,
          owner: message.frame,
          ownedAt: Date.now(),
          ownerIndex: message.index,
          phase: "working",
          updatedAt: Date.now(),
        },
      });
      sendResponse({ ok: true });
    });
    return true;
  }
});

refreshBadge();
