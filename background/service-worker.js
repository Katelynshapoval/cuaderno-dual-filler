let queue = Promise.resolve();

function enqueue(task) {
  queue = queue.then(task).catch((error) => {
    console.error(error);
  });
  return queue;
}

function badgeFor(run) {
  if (!run || run.status === "idle") {
    return { text: "", color: "#7e2b20", title: "Cuaderno Dual" };
  }
  if (run.status === "error") {
    return { text: "!", color: "#9f2d24", title: run.error || "El rellenado se ha detenido" };
  }
  if (run.status === "paused") {
    const left = Math.max((run.entries?.length || 0) - (run.index || 0), 0);
    return { text: String(left), color: "#8a5a12", title: `${left} días restantes, en pausa` };
  }
  if (run.status === "done") {
    return { text: "OK", color: "#2f6b4f", title: "Días guardados" };
  }
  const left = Math.max((run.entries?.length || 0) - (run.index || 0), 0);
  const current = run.entries?.[run.index]?.fecha || "";
  return {
    text: String(left),
    color: "#9f2d24",
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

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url || !tab.url.startsWith("https://aplicaciones.aragon.es/")) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PANEL" });
  } catch (error) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["shared/plan.js", "panel/panel.js", "content/content.js"],
    });
    await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PANEL" });
  }
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
