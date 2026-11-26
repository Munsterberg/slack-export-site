// Parse a Slack workspace export (ZIP contents, or loose JSON files) into channels.
// Slack's export is JSON: users.json, channels.json, and one folder of dated
// message files per conversation. This module is shared by the page and the tests.

const SIDE_FILES = new Set([
  "integration_logs.json",
  "canvases.json",
  "lists.json",
  "huddle_transcripts.json",
  "file_conversations.json",
]);

const DATE_FILE = /^\d{4}-\d{2}-\d{2}\.json$/i;
const MAX_TEXT = 300_000_000;
const KIND_ORDER = { channel: 0, private: 1, group_dm: 2, dm: 3, messages: 4 };

export function parseSlackExport(input) {
  const warnings = [];
  if (!Array.isArray(input) || input.length === 0) {
    return fail("No files to read.", warnings);
  }

  const files = stripCommonRoot(
    input
      .map((file) => ({
        path: normalizePath(file && file.path),
        text: file && file.text,
      }))
      .filter((file) => file.path && !isJunk(file.path) && file.path.toLowerCase().endsWith(".json"))
  );

  if (files.length === 0) {
    return fail(
      "No JSON files found. Drop a Slack export ZIP, or the channel JSON files inside it.",
      warnings
    );
  }

  const users = new Map();
  const publicChannels = new Map();
  const privateChannels = new Map();
  const channelsById = new Map();
  const dms = new Map();
  const mpimsByName = new Map();
  const mpimsById = new Map();
  const buckets = new Map();
  const skipped = [];

  for (const file of files) {
    if (typeof file.text !== "string") {
      warnings.push(`Skipped ${file.path}: it wasn't text.`);
      continue;
    }
    if (file.text.length > MAX_TEXT) {
      warnings.push(
        `Skipped ${file.path}: that file is too large to parse in a browser (${Math.round(file.text.length / 1e6)} MB).`
      );
      continue;
    }

    let data;
    try {
      data = JSON.parse(stripBom(file.text));
    } catch {
      warnings.push(`Skipped ${file.path}: the file isn't valid JSON.`);
      continue;
    }

    const base = basename(file.path);
    if ((base === "users.json" || base === "org_users.json") && Array.isArray(data)) {
      addUsers(users, data);
      continue;
    }
    if (base === "channels.json" && Array.isArray(data)) {
      for (const channel of data) addChannel(publicChannels, channelsById, channel, "channel");
      continue;
    }
    if (base === "groups.json" && Array.isArray(data)) {
      for (const channel of data) addChannel(privateChannels, channelsById, channel, "private");
      continue;
    }
    if (base === "dms.json" && Array.isArray(data)) {
      for (const dm of data) {
        if (dm && typeof dm.id === "string") dms.set(dm.id, dm);
      }
      continue;
    }
    if (base === "mpims.json" && Array.isArray(data)) {
      for (const mpim of data) {
        if (!mpim || typeof mpim !== "object") continue;
        if (typeof mpim.name === "string") mpimsByName.set(mpim.name, mpim);
        if (typeof mpim.id === "string") mpimsById.set(mpim.id, mpim);
      }
      continue;
    }

    const messages = messageList(data);
    if (!messages) {
      if (DATE_FILE.test(base)) {
        warnings.push(`Skipped ${file.path}: expected a list of messages.`);
      } else if (!SIDE_FILES.has(base)) {
        skipped.push(file.path);
      }
      continue;
    }

    const folder = channelFolder(file.path, base);
    const bucket = buckets.get(folder) || { folder, messages: [] };
    bucket.messages.push(...messages);
    buckets.set(folder, bucket);
  }

  if (skipped.length) {
    const shown = skipped.slice(0, 3).join(", ");
    const extra = skipped.length > 3 ? ` and ${skipped.length - 3} more` : "";
    warnings.push(
      `Skipped ${skipped.length} file${skipped.length === 1 ? "" : "s"} that aren't channel messages: ${shown}${extra}.`
    );
  }

  if (buckets.size === 0) {
    if (warnings.some((warning) => warning.includes("too large"))) {
      return fail(
        "A file in this export is too large to parse in a browser. Unzip it and drop one channel folder.",
        warnings
      );
    }
    return fail(noMessagesError(users.size), warnings);
  }

  const channels = [];
  for (const bucket of buckets.values()) {
    const pub = publicChannels.get(bucket.folder);
    const priv = privateChannels.get(bucket.folder);
    const dm = dms.get(bucket.folder);
    const mpim = mpimsByName.get(bucket.folder) || mpimsById.get(bucket.folder);
    const meta = pub || priv || null;
    const kind = pub ? "channel" : priv ? "private" : dm ? "dm" : mpim ? "group_dm" : guessKind(bucket.folder);
    const id = (meta && meta.id) || (dm && dm.id) || (mpim && mpim.id) || bucket.folder;
    const name = (meta && meta.name) || (mpim && mpim.name) || bucket.folder;
    const seen = new Set();
    const messages = [];

    for (const raw of bucket.messages) {
      const ts = asTs(raw.ts);
      if (!ts || seen.has(ts)) continue;
      seen.add(ts);
      const who = author(raw, users);
      messages.push({
        ts,
        iso: slackTsToIso(ts),
        user: who.name,
        userId: who.id,
        text: resolveText(rawText(raw), users, channelsById),
        thread_ts: asTs(raw.thread_ts),
        reply_count: asCount(raw.reply_count),
      });
    }

    messages.sort((a, b) => {
      const delta = tsNum(a.ts) - tsNum(b.ts);
      if (delta) return delta;
      return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
    });

    channels.push({
      id,
      key: `${kind}:${id}`,
      name,
      label: labelFor(kind, bucket.folder, meta, dm, mpim, users),
      kind,
      archived: Boolean((meta && meta.is_archived) || (mpim && mpim.is_archived)),
      messages,
    });
  }

  channels.sort((a, b) => {
    const kind = (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);
    if (kind) return kind;
    return a.label.localeCompare(b.label, "en", { sensitivity: "base" });
  });

  return { ok: true, channels, warnings, userCount: users.size };
}

export function toCsv(channel) {
  const rows = [["timestamp", "user", "text", "thread_ts", "reply_count"].join(",")];
  for (const message of channel.messages) {
    rows.push(
      [message.iso, message.user, message.text, message.thread_ts, message.reply_count].map(csvCell).join(",")
    );
  }
  return `\uFEFF${rows.join("\r\n")}\r\n`;
}

export function toMarkdown(channel) {
  const lines = [`# ${channel.label}`, "", "Times are UTC.", ""];
  let day = "";
  for (const message of channel.messages) {
    const nextDay = message.iso ? message.iso.slice(0, 10) : "Unknown date";
    const time = message.iso ? message.iso.slice(11, 16) : message.ts;
    if (nextDay !== day) {
      lines.push(`## ${nextDay}`, "");
      day = nextDay;
    }
    const thread = message.thread_ts && message.thread_ts !== message.ts ? " (thread)" : "";
    lines.push(`**${message.user}** ${time}${thread}`);
    lines.push(message.text || "");
    if (message.reply_count && message.reply_count !== "0") {
      lines.push(`*${message.reply_count} ${message.reply_count === "1" ? "reply" : "replies"}*`);
    }
    lines.push("");
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export function downloadName(channel, ext, filtered) {
  const raw = String((channel && (channel.label || channel.name)) || "channel").replace(/^#/, "");
  const safe = raw
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `slack-${safe || "channel"}${filtered ? "-filtered" : ""}.${ext}`;
}

export function slackTsToIso(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return "";
  const date = new Date(Math.round(n * 1000));
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function fail(error, warnings) {
  return { ok: false, error, channels: [], warnings, userCount: 0 };
}

function noMessagesError(userCount) {
  if (userCount) {
    return "Found users.json, but no channel messages. Drop the whole ZIP, or a channel folder of dated JSON files such as 2024-01-15.json.";
  }
  return "No Slack messages were found. Drop the ZIP from Slack's workspace export (workspace settings, then Import/Export), or the channel JSON files inside it.";
}

function normalizePath(path) {
  return String(path || "")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
}

function isJunk(path) {
  const lower = path.toLowerCase();
  if (lower.startsWith("__macosx/") || lower.includes("/__macosx/")) return true;
  const base = lower.split("/").pop();
  return base === ".ds_store" || base.startsWith("._");
}

function stripCommonRoot(files) {
  if (files.length < 2) return files;
  const root = files[0].path.split("/")[0];
  if (!root) return files;
  if (files.some((file) => file.path.split("/")[0] !== root)) return files;
  if (files.some((file) => !file.path.includes("/"))) return files;
  return files.map((file) => ({ ...file, path: file.path.slice(root.length + 1) }));
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function basename(path) {
  return path.split("/").pop();
}

function channelFolder(path, base) {
  const parts = path.split("/");
  parts.pop();
  if (parts.length) return parts[parts.length - 1];
  if (DATE_FILE.test(base)) return "messages";
  return base.replace(/\.json$/i, "");
}

function addUsers(users, list) {
  for (const user of list) {
    if (!user || typeof user.id !== "string") continue;
    const name = displayName(user);
    if (name) users.set(user.id, name);
  }
}

function displayName(user) {
  const profile = user.profile || {};
  const display = String(profile.display_name || profile.display_name_normalized || "").trim();
  if (display) return display;
  return String(profile.real_name || user.real_name || user.name || user.id || "").trim();
}

function addChannel(byName, byId, channel, kind) {
  if (!channel || typeof channel.name !== "string" || !channel.name) return;
  const meta = {
    id: typeof channel.id === "string" ? channel.id : channel.name,
    name: channel.name,
    kind,
    is_archived: Boolean(channel.is_archived),
    members: Array.isArray(channel.members) ? channel.members : [],
  };
  byName.set(meta.name, meta);
  byId.set(meta.id, meta.name);
}

function messageList(data) {
  const list = Array.isArray(data) ? data : data && typeof data === "object" ? [data] : null;
  if (!list) return null;
  const messages = list.filter(
    (item) => item && typeof item === "object" && item.ts != null && (item.type == null || item.type === "message")
  );
  return messages.length ? messages : null;
}

function guessKind(folder) {
  if (/^mpdm-/i.test(folder)) return "group_dm";
  if (/^D[A-Z0-9]+$/.test(folder)) return "dm";
  return "channel";
}

function labelFor(kind, folder, meta, dm, mpim, users) {
  if (kind === "dm") return memberLabel(dm && dm.members, users) || `DM ${folder}`;
  if (kind === "group_dm") return memberLabel(mpim && mpim.members, users) || (mpim && mpim.name) || folder;
  return `#${(meta && meta.name) || folder}`;
}

function memberLabel(members, users) {
  if (!Array.isArray(members) || members.length === 0) return "";
  return members.map((id) => users.get(id) || id).join(", ");
}

function author(message, users) {
  if (typeof message.user === "string" && users.has(message.user)) {
    return { id: message.user, name: users.get(message.user) };
  }
  if (message.user_profile && typeof message.user_profile === "object") {
    const name = displayName({ profile: message.user_profile, real_name: message.user_profile.real_name });
    if (name) return { id: typeof message.user === "string" ? message.user : "", name };
  }
  if (typeof message.username === "string" && message.username.trim()) {
    return { id: typeof message.user === "string" ? message.user : message.bot_id || "", name: message.username.trim() };
  }
  if (message.bot_profile && typeof message.bot_profile.name === "string" && message.bot_profile.name.trim()) {
    return { id: message.bot_id || "", name: message.bot_profile.name.trim() };
  }
  if (typeof message.user === "string" && message.user) return { id: message.user, name: message.user };
  return { id: "", name: "Unknown" };
}

function rawText(message) {
  if (typeof message.text === "string" && message.text.trim()) return message.text;
  if (Array.isArray(message.files)) {
    const names = message.files.map((file) => file && (file.name || file.title)).filter(Boolean);
    if (names.length) return names.join(", ");
  }
  if (Array.isArray(message.attachments)) {
    const bits = message.attachments
      .map((item) => item && (item.text || item.fallback || item.title))
      .filter(Boolean);
    if (bits.length) return bits.join("\n");
  }
  if (typeof message.subtype === "string" && message.subtype) {
    return `(${message.subtype.replaceAll("_", " ")})`;
  }
  return "";
}

function resolveText(text, users, channelsById) {
  const replaced = text.replace(/<([^<>\n]+)>/g, (full, inner) => replaceToken(full, inner, users, channelsById));
  return replaced.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function replaceToken(full, inner, users, channelsById) {
  if (inner.startsWith("@")) {
    const [id, label] = splitLabel(inner.slice(1));
    const name = users.get(id) || label || id;
    return `@${String(name).replace(/^@/, "")}`;
  }
  if (inner.startsWith("#")) {
    const [id, label] = splitLabel(inner.slice(1));
    const name = channelsById.get(id) || label || id;
    return `#${String(name).replace(/^#/, "")}`;
  }
  if (inner.startsWith("!")) {
    if (inner.startsWith("!subteam^")) {
      const [id, label] = splitLabel(inner.slice("!subteam^".length));
      return `@${String(label || id).replace(/^@/, "")}`;
    }
    return `@${inner.slice(1).split("|")[0]}`;
  }
  if (/^(https?:|mailto:|tel:|ftp:)/i.test(inner)) {
    const [url, label] = splitLabel(inner);
    if (label && label !== url) return `${label} (${url})`;
    return url;
  }
  return full;
}

function splitLabel(body) {
  const index = body.indexOf("|");
  if (index === -1) return [body, ""];
  return [body.slice(0, index), body.slice(index + 1)];
}

function asTs(value) {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function asCount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}

function tsNum(ts) {
  const n = Number(ts);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

function csvCell(value) {
  let text = value == null ? "" : String(value);
  // Excel treats a leading = or + as a formula. Mentions start with @, so leave those alone.
  if (/^[=+]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}
