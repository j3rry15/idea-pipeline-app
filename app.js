"use strict";

const $ = (id) => document.getElementById(id);
const API = "https://api.github.com";

// ---------- settings ----------

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem("ip.settings")) || {};
  } catch {
    return {};
  }
}

function saveSettings(s) {
  localStorage.setItem("ip.settings", JSON.stringify(s));
}

function configured() {
  const s = loadSettings();
  return s.owner && s.repo && s.token;
}

// ---------- offline queue ----------

function loadQueue() {
  try {
    return JSON.parse(localStorage.getItem("ip.queue")) || [];
  } catch {
    return [];
  }
}

function saveQueue(q) {
  localStorage.setItem("ip.queue", JSON.stringify(q));
  renderQueueBanner();
}

function renderQueueBanner() {
  const q = loadQueue();
  const banner = $("queueBanner");
  if (q.length === 0) {
    banner.classList.add("hidden");
  } else {
    banner.classList.remove("hidden");
    $("queueCount").textContent =
      q.length === 1 ? "1 idea waiting to upload" : `${q.length} ideas waiting to upload`;
  }
}

// ---------- GitHub ----------

async function gh(path, opts = {}) {
  const s = loadSettings();
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${s.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function b64EncodeUnicode(str) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(str)));
}

async function commitIdea(idea) {
  const s = loadSettings();
  const path = `ideas/inbox/${idea.id}.json`;
  const content = b64EncodeUnicode(JSON.stringify(idea, null, 2) + "\n");
  await gh(`/repos/${s.owner}/${s.repo}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    body: JSON.stringify({ message: `idea: ${idea.title}`, content }),
  });
}

// ---------- idea building ----------

function slugify(title) {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "idea";
  const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  return `${base}-${stamp}`;
}

function buildIdea() {
  const title = $("title").value.trim();
  return {
    id: slugify(title),
    title,
    pitch: $("pitch").value.trim(),
    notes: $("notes").value.trim(),
    startingPrompt: $("startingPrompt").value.trim(),
    tags: $("tags").value.split(",").map((t) => t.trim()).filter(Boolean),
    created: new Date().toISOString(),
    status: "inbox",
    project: null,
    milestones: [],
    stats: null,
  };
}

// ---------- actions ----------

function setStatus(msg, cls) {
  const el = $("status");
  el.textContent = msg;
  el.className = cls || "";
}

async function flushQueue() {
  let q = loadQueue();
  while (q.length > 0) {
    try {
      await commitIdea(q[0]);
      q = q.slice(1);
      saveQueue(q);
    } catch (e) {
      // conflict means it was already uploaded — drop it and continue
      if (String(e.message).includes("422") || String(e.message).includes("409")) {
        q = q.slice(1);
        saveQueue(q);
        continue;
      }
      throw e;
    }
  }
}

async function onSubmit(ev) {
  ev.preventDefault();
  if (!configured()) {
    $("settingsDialog").showModal();
    return;
  }
  const idea = buildIdea();
  const btn = $("saveBtn");
  btn.disabled = true;
  setStatus("Uploading…");
  try {
    await flushQueue();
    await commitIdea(idea);
    setStatus(`Saved ✓ — "${idea.title}" is waiting on your desktop.`, "ok");
    $("ideaForm").reset();
    refreshList().catch(() => {});
  } catch (e) {
    const q = loadQueue();
    q.push(idea);
    saveQueue(q);
    setStatus("Offline or GitHub unreachable — queued on this phone.", "err");
    console.error(e);
  } finally {
    btn.disabled = false;
  }
}

async function refreshList() {
  if (!configured()) return;
  const s = loadSettings();
  const ul = $("ideaList");
  try {
    const dirs = [
      ["inbox", "ideas/inbox"],
      ["active", "ideas/active"],
    ];
    const items = [];
    for (const [label, dir] of dirs) {
      try {
        const files = await gh(`/repos/${s.owner}/${s.repo}/contents/${dir}`);
        for (const f of files) {
          if (f.name.endsWith(".json")) {
            items.push({ name: f.name.replace(/\.json$/, ""), label });
          }
        }
      } catch {
        // directory may not exist yet — fine
      }
    }
    ul.innerHTML = "";
    if (items.length === 0) {
      ul.innerHTML = '<li class="muted">Nothing yet — capture your first idea above.</li>';
      return;
    }
    for (const it of items) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = it.name;
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = it.label === "inbox" ? "📥 inbox" : "🔨 active";
      li.append(name, tag);
      ul.appendChild(li);
    }
  } catch (e) {
    ul.innerHTML = `<li class="muted">Could not load list (${e.message.slice(0, 60)})</li>`;
  }
}

// ---------- settings dialog ----------

function openSettings() {
  const s = loadSettings();
  $("cfgOwner").value = s.owner || "";
  $("cfgRepo").value = s.repo || "idea-pipeline";
  $("cfgToken").value = s.token || "";
  $("settingsDialog").showModal();
}

// ---------- voice capture ----------

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let listening = false;
let voiceText = "";

function setVoiceUi(on) {
  listening = on;
  const btn = $("voiceBtn");
  btn.classList.toggle("listening", on);
  btn.textContent = on ? "⏹ Listening… tap to finish" : "🎤 Dictate the idea";
}

function fillFromTranscript(text) {
  text = text.trim();
  if (!text) return;
  const firstSentence = text.split(/(?<=[.!?])\s/)[0] || text;
  const title = firstSentence.length > 60
    ? firstSentence.slice(0, 60).replace(/\s+\S*$/, "") + "…"
    : firstSentence;
  if (!$("title").value.trim()) $("title").value = title;
  $("notes").value = ($("notes").value.trim() ? $("notes").value + "\n\n" : "") + text;
  if (!$("startingPrompt").value.trim()) {
    $("startingPrompt").value =
      "This idea was dictated as a voice note — the raw transcript is in the " +
      "idea notes. Turn it into a concrete plan, ask me about anything that's " +
      "unclear or ambiguous, then start building an MVP.";
  }
  setStatus("Transcript captured — review and hit Send.", "ok");
}

function stopVoice() {
  setVoiceUi(false);
  if (rec) {
    rec.onend = null;
    try { rec.stop(); } catch {}
    rec = null;
  }
  $("voicePreview").classList.add("hidden");
  // never let the "…" placeholder leak into the form
  fillFromTranscript(voiceText.replace(/^[…\s]+/, ""));
}

function startVoice() {
  if (!SR) {
    setStatus("Speech recognition isn't available here — use the 🎤 on the keyboard instead.", "err");
    return;
  }
  voiceText = "";
  rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (e) => {
    // Rebuild from the full results list every event, never append across
    // events. iOS Safari reports cumulative transcripts (each result restates
    // everything said so far), so a result that extends what we already have
    // REPLACES it; anything else is a genuinely new segment and is appended.
    let text = "";
    for (let i = 0; i < e.results.length; i++) {
      const t = (e.results[i][0].transcript || "").replace(/\s+/g, " ").trim();
      if (!t) continue;
      if (text && t.toLowerCase().startsWith(text.toLowerCase())) text = t;
      else text = text ? text + " " + t : t;
    }
    voiceText = text;
    const preview = $("voicePreview");
    preview.classList.remove("hidden");
    preview.textContent = voiceText || "…";
  };
  rec.onerror = (e) => {
    setVoiceUi(false);
    $("voicePreview").classList.add("hidden");
    rec = null;
    setStatus(
      e.error === "not-allowed"
        ? "Microphone access was denied — allow it in Settings, or use the keyboard 🎤."
        : `Voice input failed (${e.error}) — use the keyboard 🎤 instead.`,
      "err"
    );
  };
  // iOS/Android may end recognition on a long pause — treat that as "finished"
  rec.onend = () => { if (listening) stopVoice(); };
  const preview = $("voicePreview");
  preview.classList.remove("hidden");
  preview.textContent = "…";
  setVoiceUi(true);
  rec.start();
}

$("voiceBtn").addEventListener("click", () => (listening ? stopVoice() : startVoice()));

// ---------- wiring ----------

$("ideaForm").addEventListener("submit", onSubmit);
$("settingsBtn").addEventListener("click", openSettings);
$("refreshBtn").addEventListener("click", () => refreshList());
$("flushBtn").addEventListener("click", async () => {
  setStatus("Retrying queued ideas…");
  try {
    await flushQueue();
    setStatus("Queue uploaded ✓", "ok");
  } catch {
    setStatus("Still unreachable — will keep the queue.", "err");
  }
});

$("settingsForm").addEventListener("submit", (ev) => {
  if (ev.submitter && ev.submitter.value === "save") {
    saveSettings({
      owner: $("cfgOwner").value.trim(),
      repo: $("cfgRepo").value.trim(),
      token: $("cfgToken").value.trim(),
    });
    refreshList().catch(() => {});
  }
});

window.addEventListener("online", () => flushQueue().catch(() => {}));

renderQueueBanner();
if (configured()) {
  flushQueue().catch(() => {});
  refreshList().catch(() => {});
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
