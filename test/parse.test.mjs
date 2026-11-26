import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { downloadName, parseSlackExport, slackTsToIso, toCsv, toMarkdown } from "../slack-export-parse.js";

const require = createRequire(import.meta.url);
const fflate = require("../vendor/fflate.js");

const fixtureDir = path.join(import.meta.dirname, "fixtures", "sample-export");
const usersJson = readFileSync(path.join(fixtureDir, "users.json"), "utf8");

function readTree(dir, prefix = "") {
  const files = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(abs).isDirectory()) files.push(...readTree(abs, rel));
    else files.push({ path: rel, text: readFileSync(abs, "utf8") });
  }
  return files;
}

function channel(result, label) {
  const found = result.channels.find((item) => item.label === label);
  assert.ok(found, `missing channel ${label}`);
  return found;
}

test("parses the sample export: names, mentions, order, CSV, and Markdown", () => {
  const result = parseSlackExport(readTree(fixtureDir));
  assert.equal(result.ok, true);
  assert.equal(result.userCount, 2);
  assert.deepEqual(
    result.channels.map((item) => item.label),
    ["#general", "#secret", "Priya, Marcus Lee"]
  );
  assert.equal(result.channels[1].kind, "private");
  assert.equal(result.channels[2].kind, "dm");

  const general = channel(result, "#general");
  assert.deepEqual(
    general.messages.map((message) => message.ts),
    ["1709279900.000000", "1709280000.000100", "1709280300.000200"]
  );

  const [join, hello, reply] = general.messages;
  assert.equal(join.user, "Marcus Lee");
  assert.equal(join.text, "@Marcus Lee has joined the channel");
  assert.equal(join.iso, "2024-03-01T07:58:20.000Z");
  assert.equal(join.thread_ts, "");
  assert.equal(join.reply_count, "");

  assert.equal(hello.user, "Priya");
  assert.equal(hello.text, "Hello @Marcus Lee, the logo is ready & waiting. See #launch and @here.");
  assert.equal(hello.iso, slackTsToIso("1709280000.000100"));
  assert.equal(hello.iso, "2024-03-01T08:00:00.000Z");
  assert.equal(hello.thread_ts, "1709280000.000100");
  assert.equal(hello.reply_count, "1");

  assert.equal(reply.user, "Marcus Lee");
  assert.equal(reply.text, "Looks good @Priya");
  assert.equal(reply.thread_ts, "1709280000.000100");
  assert.equal(reply.reply_count, "");

  assert.equal(channel(result, "#secret").messages[0].text, "Private note for @Marcus Lee 🎉");
  assert.equal(channel(result, "Priya, Marcus Lee").messages[0].text, "Can you review?");

  const csv = toCsv(general);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const rows = csv.slice(1).trimEnd().split("\r\n");
  assert.deepEqual(rows[0].split(","), ["timestamp", "user", "text", "thread_ts", "reply_count"]);
  assert.equal(
    rows[2],
    '2024-03-01T08:00:00.000Z,Priya,"Hello @Marcus Lee, the logo is ready & waiting. See #launch and @here.",1709280000.000100,1'
  );
  assert.equal(rows[1], "2024-03-01T07:58:20.000Z,Marcus Lee,@Marcus Lee has joined the channel,,");
  assert.equal(rows[3], "2024-03-01T08:05:00.000Z,Marcus Lee,Looks good @Priya,1709280000.000100,");

  const markdown = toMarkdown(general);
  assert.match(markdown, /^# #general\n/);
  assert.match(markdown, /\*\*Priya\*\* 08:00\nHello @Marcus Lee/);
  assert.match(markdown, /\*\*Marcus Lee\*\* 08:05 \(thread\)\nLooks good @Priya/);
  assert.match(markdown, /\*1 reply\*/);
  assert.equal(downloadName(general, "csv"), "slack-general.csv");
  assert.equal(downloadName(result.channels[2], "md", true), "slack-Priya-Marcus-Lee-filtered.md");
});

test("reads the same sample export from a ZIP", () => {
  const files = readTree(fixtureDir);
  const zipped = {};
  for (const file of files) zipped[`Acme Slack export/${file.path}`] = fflate.strToU8(file.text);
  zipped["Acme Slack export/__MACOSX/._users.json"] = fflate.strToU8("junk");
  const unzipped = fflate.unzipSync(fflate.zipSync(zipped));
  const fromZip = Object.entries(unzipped).map(([filePath, bytes]) => ({
    path: filePath,
    text: fflate.strFromU8(bytes),
  }));
  const result = parseSlackExport(fromZip);
  assert.equal(result.ok, true);
  assert.equal(result.channels.length, 3);
  assert.equal(channel(result, "#general").messages.length, 3);
  assert.equal(channel(result, "#secret").messages[0].text, "Private note for @Marcus Lee 🎉");
  assert.equal(result.warnings.length, 0);
});

test("groups loose channel JSON files and keeps a bad file from discarding the rest", () => {
  const result = parseSlackExport([
    { path: "users.json", text: usersJson },
    { path: "random\\2024-04-01.json", text: `\uFEFF${JSON.stringify([{ type: "message", user: "U001", text: "one", ts: "1709366400.000100" }])}` },
    { path: "random/2024-04-02.json", text: JSON.stringify([{ type: "message", user: "U999", text: "Hi <@U404>", ts: "1709280000.000100" }]) },
    { path: "notes.json", text: "{" },
    { path: "readme.json", text: JSON.stringify({ hello: true }) },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.channels.length, 1);
  assert.equal(result.channels[0].label, "#random");
  assert.deepEqual(
    result.channels[0].messages.map((message) => message.text),
    ["Hi @U404", "one"]
  );
  assert.equal(result.channels[0].messages[0].user, "U999");
  assert.ok(result.warnings.some((warning) => warning.includes("notes.json")));
  assert.ok(result.warnings.some((warning) => warning.includes("readme.json")));
});

test("resolves files, bots, links, and escapes CSV formulas", () => {
  const result = parseSlackExport([
    {
      path: "general/2024-03-01.json",
      text: JSON.stringify([
        { type: "message", user: "U001", text: "", ts: "10", files: [{ name: "logo.png" }] },
        { type: "message", subtype: "bot_message", username: "shipit", text: "deployed", ts: "11" },
        { type: "message", user: "U001", text: "See <https://example.com?a=1&amp;b=2|docs> and <!subteam^S1|crew>", ts: "12" },
        { type: "message", user: "U001", text: '=1+1, "quoted"\nnext', ts: "13" },
        { type: "message", user: "U001", text: "first", ts: "14" },
        { type: "message", user: "U001", text: "duplicate", ts: "14" },
        { type: "message", text: "<not a mention>", ts: "15" },
      ]),
    },
  ]);
  const messages = result.channels[0].messages;
  assert.deepEqual(
    messages.map((message) => message.text),
    ["logo.png", "deployed", "See docs (https://example.com?a=1&b=2) and @crew", '=1+1, "quoted"\nnext', "first", "<not a mention>"]
  );
  assert.equal(messages[1].user, "shipit");
  assert.equal(messages[5].user, "Unknown");
  const csv = toCsv(result.channels[0]);
  assert.match(csv, /"'=1\+1, ""quoted""\nnext"/);
});

test("reads a direct message and a group DM from metadata", () => {
  const result = parseSlackExport([
    { path: "users.json", text: usersJson },
    {
      path: "mpims.json",
      text: JSON.stringify([{ id: "G999", name: "mpdm-priya--marcus-1", members: ["U001", "U002"] }]),
    },
    {
      path: "mpdm-priya--marcus-1/2024-03-01.json",
      text: JSON.stringify([{ type: "message", user: "U001", text: "hey", ts: "1709280000.000100" }]),
    },
  ]);
  assert.equal(result.channels[0].kind, "group_dm");
  assert.equal(result.channels[0].label, "Priya, Marcus Lee");
  assert.equal(result.channels[0].messages[0].text, "hey");
});

test("reports a clear error when the export has no messages", () => {
  const onlyUsers = parseSlackExport([{ path: "users.json", text: usersJson }]);
  assert.equal(onlyUsers.ok, false);
  assert.match(onlyUsers.error, /no channel messages/i);

  const empty = parseSlackExport([]);
  assert.equal(empty.ok, false);
  assert.match(empty.error, /No files/);

  const big = parseSlackExport([{ path: "general/2024-01-01.json", text: "x".repeat(300_000_001) }]);
  assert.equal(big.ok, false);
  assert.match(big.error, /too large/i);
});

test("keeps thousands of messages in timestamp order", () => {
  const messages = [];
  for (let i = 2999; i >= 0; i -= 1) {
    messages.push({ type: "message", user: "U001", text: `Message ${i}`, ts: String(1_700_000_000 + i) });
  }
  const result = parseSlackExport([
    { path: "users.json", text: usersJson },
    { path: "general/2024-01-01.json", text: JSON.stringify(messages) },
  ]);
  assert.equal(result.channels[0].messages.length, 3000);
  assert.equal(result.channels[0].messages[0].text, "Message 0");
  assert.equal(result.channels[0].messages[0].user, "Priya");
  assert.equal(result.channels[0].messages[2999].text, "Message 2999");
  const csv = toCsv(result.channels[0]);
  assert.equal(csv.split("\r\n").length, 3002);
});
