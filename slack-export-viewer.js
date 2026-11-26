import { downloadName, parseSlackExport, toCsv, toMarkdown } from "./slack-export-parse.js";

const PAGE = 100;
const SOFT_BYTES = 250 * 1024 * 1024;
const HARD_BYTES = 1024 * 1024 * 1024;
const MAX_FILES = 20000;
const SKIP_DIRS = new Set(["node_modules", ".git", "__MACOSX"]);

const root = document.querySelector("[data-viewer]");
if (root) {
  const dom = {
    drop: root.querySelector("[data-drop]"),
    fileInput: root.querySelector("[data-file]"),
    dirInput: root.querySelector("[data-dir]"),
    status: root.querySelector("[data-status]"),
    error: root.querySelector("[data-error]"),
    warnings: root.querySelector("[data-warnings]"),
    app: root.querySelector("[data-app]"),
    channel: root.querySelector("[data-channel]"),
    search: root.querySelector("[data-search]"),
    count: root.querySelector("[data-count]"),
    log: root.querySelector("[data-log]"),
    more: root.querySelector("[data-more]"),
    csv: root.querySelector("[data-csv]"),
    md: root.querySelector("[data-md]"),
  };

  const state = {
    generation: 0,
    channels: [],
    index: 0,
    query: "",
    shown: PAGE,
    source: "",
  };

  let searchTimer = 0;

  dom.fileInput.addEventListener("change", () => {
    const files = [...dom.fileInput.files];
    dom.fileInput.value = "";
    if (files.length) openRecords(files.map(fileRecord));
  });

  dom.dirInput.addEventListener("change", () => {
    const files = [...dom.dirInput.files];
    dom.dirInput.value = "";
    if (files.length) openRecords(files.map(fileRecord));
  });

  const draggingFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");

  document.addEventListener("dragenter", (event) => {
    if (!draggingFiles(event)) return;
    event.preventDefault();
    dom.drop.classList.add("is-drag");
  });
  document.addEventListener("dragover", (event) => {
    if (!draggingFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    dom.drop.classList.add("is-drag");
  });
  document.addEventListener("dragleave", (event) => {
    if (!event.relatedTarget) dom.drop.classList.remove("is-drag");
  });
  document.addEventListener("drop", (event) => {
    dom.drop.classList.remove("is-drag");
    if (!draggingFiles(event)) return;
    event.preventDefault();
    void openDrop(event.dataTransfer);
  });

  dom.channel.addEventListener("change", () => {
    state.index = dom.channel.selectedIndex;
    state.shown = PAGE;
    ensureSearchKeys(current());
    render();
  });

  dom.search.addEventListener("input", () => {
    state.query = dom.search.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.shown = PAGE;
      render();
    }, 150);
  });

  dom.more.addEventListener("click", () => {
    state.shown += PAGE;
    render();
  });

  dom.csv.addEventListener("click", () => download("csv"));
  dom.md.addEventListener("click", () => download("md"));

  function fileRecord(file) {
    const rel = file.webkitRelativePath ? file.webkitRelativePath : file.name;
    return { file, path: rel || file.name };
  }

  async function openDrop(transfer) {
    const records = [];
    const fallback = [...transfer.files].map(fileRecord);
    const items = [...(transfer.items || [])];
    const entries = items.map(asEntry).filter(Boolean);
    if (entries.length) {
      setBusy(true);
      setStatus("Reading the dropped files…");
      try {
        for (const entry of entries) await walkEntry(entry, "", records);
      } catch {
        setBusy(false);
        showError("That folder couldn't be read. Try Choose a folder, or drop the ZIP.");
        return;
      }
    }
    if (!records.length) records.push(...fallback);
    if (!records.length) {
      setBusy(false);
      showError("Nothing was dropped. Drop a Slack export ZIP, or channel JSON files.");
      return;
    }
    await openRecords(records);
  }

  function asEntry(item) {
    if (typeof item.getAsEntry === "function") return item.getAsEntry();
    if (typeof item.webkitGetAsEntry === "function") return item.webkitGetAsEntry();
    return null;
  }

  async function walkEntry(entry, prefix, out) {
    if (out.length > MAX_FILES) return;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile) {
      if (!isUsefulName(entry.name)) return;
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ file, path });
      return;
    }
    if (!entry.isDirectory || SKIP_DIRS.has(entry.name)) return;
    const reader = entry.createReader();
    const children = [];
    while (children.length <= MAX_FILES) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      children.push(...batch);
    }
    for (const child of children) await walkEntry(child, path, out);
  }

  async function openRecords(records) {
    const generation = ++state.generation;
    window.clearTimeout(searchTimer);
    clearError();
    setBusy(true);
    root.classList.remove("is-loaded");
    dom.app.hidden = true;
    dom.warnings.hidden = true;
    dom.warnings.replaceChildren();

    const useful = records.filter((record) => keepRecord(record, records.length === 1));
    if (!useful.length) {
      setBusy(false);
      showError("Drop a Slack export ZIP, or JSON files from a channel. Other file types are ignored.");
      return;
    }
    if (useful.length > MAX_FILES) {
      setBusy(false);
      showError(`That folder has more than ${MAX_FILES.toLocaleString("en")} files. Drop the ZIP, or a single channel folder.`);
      return;
    }

    const total = useful.reduce((sum, record) => sum + (record.file.size || 0), 0);
    if (total > HARD_BYTES) {
      setBusy(false);
      showError(
        `This export is ${formatBytes(total)}. That's too large to open in a browser tab. Unzip it and drop one channel folder.`
      );
      return;
    }

    const zips = [];
    const jsons = [];
    for (const record of useful) {
      if (isZipName(record)) zips.push(record);
      else if (isJsonName(record)) jsons.push(record);
    }

    if (!zips.length && !jsons.length && useful.length === 1) {
      if (await looksLikeZip(useful[0].file)) zips.push(useful[0]);
    }
    if (generation !== state.generation) return;

    if (!zips.length && !jsons.length) {
      setBusy(false);
      showError("Drop a Slack export ZIP, or JSON files from a channel. Other file types are ignored.");
      return;
    }

    const stale = () => generation !== state.generation;
    const notes = [];
    if (total > SOFT_BYTES) {
      notes.push("This is a large export. Parsing stays in this tab and can take a minute. If the page stops responding, drop one channel folder instead.");
    }
    if (zips.length > 1) notes.push("Opened more than one ZIP as a single export.");

    try {
      const parsed = [];
      const zipRecords = zips;
      const jsonRecords = zips.length && jsons.length ? [] : jsons;
      if (zips.length && jsons.length) {
        notes.push("Used the ZIP and ignored loose JSON files dropped with it.");
      }

      for (const record of zipRecords) {
        if (stale()) return;
        setStatus(`Reading ${record.file.name}…`);
        const bytes = new Uint8Array(await readBuffer(record.file, (loaded, fileTotal) => {
          if (!stale()) setStatus(`Reading ${record.file.name}… ${Math.round((loaded / fileTotal) * 100)}%`);
        }));
        if (stale()) return;
        setStatus(`Opening ${record.file.name}…`);
        await paint();
        const unzipped = await unzip(bytes);
        const names = Object.keys(unzipped);
        if (!names.length) throw new Error("empty-zip");
        for (let i = 0; i < names.length; i += 1) {
          if (stale()) return;
          parsed.push({ path: names[i], text: new TextDecoder("utf-8").decode(unzipped[names[i]]) });
          if (i > 0 && i % 40 === 0) {
            setStatus(`Reading files in ${record.file.name} (${i.toLocaleString("en")} of ${names.length.toLocaleString("en")})…`);
            await paint();
          }
        }
      }

      for (let i = 0; i < jsonRecords.length; i += 1) {
        if (stale()) return;
        const record = jsonRecords[i];
        parsed.push({ path: record.path || record.file.name, text: await record.file.text() });
        if (i > 0 && i % 40 === 0) {
          setStatus(`Reading files (${i.toLocaleString("en")} of ${jsonRecords.length.toLocaleString("en")})…`);
          await paint();
        }
      }

      if (stale()) return;
      setStatus("Parsing messages…");
      await paint();
      const result = parseSlackExport(parsed);
      if (stale()) return;
      if (!result.ok) {
        setBusy(false);
        showError(result.error);
        showWarnings(result.warnings);
        return;
      }

      state.channels = result.channels;
      state.index = 0;
      state.query = "";
      state.shown = PAGE;
      state.source = sourceLabel(zipRecords, jsonRecords);
      dom.search.value = "";
      root.classList.add("is-loaded");
      fillChannels();
      ensureSearchKeys(current());
      dom.app.hidden = false;
      render();
      const count = result.channels.reduce((sum, item) => sum + item.messages.length, 0);
      const channelNoun = result.channels.length === 1 ? "channel" : "channels";
      const messageNoun = count === 1 ? "message" : "messages";
      const names = result.userCount
        ? `Names resolved for ${result.userCount.toLocaleString("en")} ${result.userCount === 1 ? "person" : "people"}.`
        : "Names are still user IDs because users.json was not in the file.";
      setStatus(`Opened ${state.source}. ${result.channels.length.toLocaleString("en")} ${channelNoun}, ${count.toLocaleString("en")} ${messageNoun}. ${names}`);
      showWarnings([...notes, ...result.warnings]);
      setBusy(false);
      dom.channel.focus({ preventScroll: true });
    } catch (error) {
      if (stale()) return;
      setBusy(false);
      showError(loadError(error));
    }
  }

  function fillChannels() {
    dom.channel.replaceChildren();
    for (const channel of state.channels) {
      const option = document.createElement("option");
      const count = channel.messages.length;
      const archived = channel.archived ? ", archived" : "";
      const noun = count === 1 ? "message" : "messages";
      option.value = channel.key;
      option.textContent = `${channel.label}${archived} (${count.toLocaleString("en")} ${noun})`;
      dom.channel.append(option);
    }
    dom.channel.selectedIndex = 0;
  }

  function current() {
    return state.channels[state.index] || state.channels[0];
  }

  function ensureSearchKeys(channel) {
    if (!channel || channel.searchReady) return;
    for (const message of channel.messages) {
      message.search = `${message.user}\n${message.text}\n${message.iso}`.toLowerCase();
    }
    channel.searchReady = true;
  }

  function matching(channel) {
    const query = state.query.trim().toLowerCase();
    if (!query) return channel.messages;
    return channel.messages.filter((message) => message.search.includes(query));
  }

  function render() {
    const channel = current();
    if (!channel) return;
    const all = matching(channel);
    const slice = all.slice(0, state.shown);
    const fragment = document.createDocumentFragment();
    for (const message of slice) fragment.append(renderMessage(message));
    dom.log.replaceChildren(fragment);

    const total = channel.messages.length;
    const query = state.query.trim();
    if (!total) dom.count.textContent = "No messages in this channel.";
    else if (query && all.length === 0) dom.count.textContent = "No messages match that search.";
    else if (query) dom.count.textContent = `${all.length.toLocaleString("en")} of ${total.toLocaleString("en")} messages match. Downloads use the matches.`;
    else if (state.shown < all.length) dom.count.textContent = `Showing ${slice.length.toLocaleString("en")} of ${total.toLocaleString("en")} messages.`;
    else dom.count.textContent = total === 1 ? "1 message." : `${total.toLocaleString("en")} messages.`;

    const more = state.shown < all.length;
    dom.more.hidden = !more;
    if (more) {
      const left = all.length - state.shown;
      dom.more.textContent = `Show ${Math.min(PAGE, left).toLocaleString("en")} more`;
    }
    const canDownload = all.length > 0;
    dom.csv.disabled = !canDownload;
    dom.md.disabled = !canDownload;
    dom.csv.textContent = query ? "Download CSV (matches)" : "Download CSV";
    dom.md.textContent = query ? "Download Markdown (matches)" : "Download Markdown";
  }

  function renderMessage(message) {
    const reply = message.thread_ts && message.thread_ts !== message.ts;
    const item = el("li", reply ? "viewer-msg is-reply" : "viewer-msg");
    const meta = el("p", "msg-meta");
    meta.append(el("b", null, message.user));
    const time = el("time", null, formatWhen(message.iso));
    if (message.iso) time.dateTime = message.iso;
    meta.append(time);
    item.append(meta);
    item.append(el("p", message.text ? "viewer-text" : "viewer-text is-empty", message.text || "(no text)"));
    if (message.reply_count && message.reply_count !== "0") {
      const count = Number(message.reply_count);
      item.append(el("p", "thread-link", count === 1 ? "1 reply" : `${message.reply_count} replies`));
    } else if (reply) {
      item.append(el("p", "thread-link", "Thread reply"));
    }
    return item;
  }

  function download(ext) {
    const channel = current();
    if (!channel) return;
    const messages = matching(channel);
    if (!messages.length) return;
    const filtered = Boolean(state.query.trim());
    const view = filtered ? { ...channel, messages } : channel;
    const text = ext === "csv" ? toCsv(view) : toMarkdown(view);
    const name = downloadName(channel, ext, filtered);
    const type = ext === "csv" ? "text/csv;charset=utf-8" : "text/markdown;charset=utf-8";
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function sourceLabel(zips, jsons) {
    if (zips.length === 1) return zips[0].file.name;
    if (zips.length > 1) return `${zips.length} ZIP files`;
    if (jsons.length === 1) return jsons[0].file.name;
    return `${jsons.length} JSON files`;
  }

  function loadError(error) {
    if (error && error.message === "empty-zip") {
      return "That ZIP has no JSON files. Slack's export contains users.json and a folder of JSON files per channel.";
    }
    if (error && error.message === "missing-zip-reader") {
      return "The ZIP reader didn't load. Refresh the page, or unzip the export and drop the JSON files.";
    }
    const message = error && error.message ? error.message : "";
    if (/password|encrypted/i.test(message)) {
      return "This ZIP looks password-protected. Slack's export is not password-protected. Unzip it and drop the JSON files.";
    }
    if (/zip|compression|invalid/i.test(message) || (error && error.code != null)) {
      return "This ZIP couldn't be opened. It may be damaged. Unzip it and drop the JSON files instead.";
    }
    if (error && (error.name === "NotReadableError" || error.name === "AbortError" || error.name === "SecurityError")) {
      return "The file couldn't be read. It may have moved, or the browser blocked it. Choose it again.";
    }
    return "Something went wrong while reading this export. Try the ZIP again, or drop a single channel folder of JSON files.";
  }

  function unzip(bytes) {
    const fflate = globalThis.fflate;
    if (!fflate || typeof fflate.unzip !== "function") {
      return Promise.reject(new Error("missing-zip-reader"));
    }
    const options = {
      filter(file) {
        const name = String(file.name || "").replaceAll("\\", "/");
        if (!name || name.endsWith("/")) return false;
        return isUsefulName(name);
      },
    };
    return new Promise((resolve, reject) => {
      fflate.unzip(bytes, options, (error, data) => {
        if (!error) {
          resolve(data || {});
          return;
        }
        try {
          resolve(fflate.unzipSync(bytes, options));
        } catch (syncError) {
          reject(syncError);
        }
      });
    });
  }

  function readBuffer(file, onProgress) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onprogress = (event) => {
        if (event.lengthComputable && onProgress) onProgress(event.loaded, event.total);
      };
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("read-failed"));
      reader.readAsArrayBuffer(file);
    });
  }

  async function looksLikeZip(file) {
    try {
      const bytes = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
    } catch {
      return false;
    }
  }

  function keepRecord(record, alone) {
    if (!record.file) return false;
    if (isZipName(record) || isJsonName(record)) return true;
    return alone;
  }

  function isZipName(record) {
    const name = (record.path || record.file.name || "").toLowerCase();
    const type = (record.file.type || "").toLowerCase();
    return name.endsWith(".zip") || type.includes("zip");
  }

  function isJsonName(record) {
    return (record.path || record.file.name || "").toLowerCase().endsWith(".json");
  }

  function isUsefulName(name) {
    const lower = String(name || "").replaceAll("\\", "/").toLowerCase();
    if (!lower || lower.startsWith("__macosx/") || lower.includes("/__macosx/")) return false;
    const base = lower.split("/").pop();
    if (!base || base === ".ds_store" || base.startsWith("._")) return false;
    return base.endsWith(".json") || base.endsWith(".zip");
  }

  function formatWhen(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  function setStatus(text) {
    dom.status.textContent = text;
  }

  function showError(text) {
    dom.error.hidden = false;
    dom.error.textContent = text;
    setStatus("");
  }

  function clearError() {
    dom.error.hidden = true;
    dom.error.textContent = "";
  }

  function showWarnings(warnings) {
    dom.warnings.replaceChildren();
    if (!warnings || !warnings.length) {
      dom.warnings.hidden = true;
      return;
    }
    for (const warning of warnings) {
      const item = document.createElement("li");
      item.textContent = warning;
      dom.warnings.append(item);
    }
    dom.warnings.hidden = false;
  }

  function setBusy(busy) {
    root.setAttribute("aria-busy", busy ? "true" : "false");
    dom.fileInput.disabled = busy;
    dom.dirInput.disabled = busy;
  }

  function paint() {
    return new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
}
