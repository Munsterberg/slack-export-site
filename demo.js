// Interactive hero demo: the same conversation rendered in each export format.
(() => {
  const demo = document.querySelector("[data-demo]");
  if (!demo) return;

  const base = "slack-northwind-q3-launch-2026-10-14";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const md = `<pre class="as-text"><b># #q3-launch</b>
<i>Workspace: Northwind</i>
<i>Exported: 2026-10-14</i>

<b>## 2026-09-02</b>

<b>**Priya Shah**</b> 10:14
Final logo files are in the drive. Can someone check the dark variant before Friday?
[northwind-logo-dark.png](https://files.slack.com/...)

&gt; <b>**Marcus Lee**</b> 10:21
&gt; Looks right. The wordmark spacing is fixed too.

<b>**Marcus Lee**</b> 10:58
I'll post the announcement Monday morning.

<b>**Dana Ortiz**</b> 11:03
Approved. Shipping it 🎉
<i>Reactions: 🎉 3</i></pre>`;

  const csv = `<pre class="as-text is-csv"><b>date,time,user,text,thread_parent,files,reactions</b>
2026-09-02,10:14,Priya Shah,"Final logo files are in the drive. Can someone check the dark variant before Friday?",,northwind-logo-dark.png,
2026-09-02,10:21,Marcus Lee,"Looks right. The wordmark spacing is fixed too.",10:14,,
2026-09-02,10:58,Marcus Lee,"I'll post the announcement Monday morning.",,,
2026-09-02,11:03,Dana Ortiz,"Approved. Shipping it 🎉",,,🎉 3</pre>`;

  const html = `<article class="as-html">
  <header>
    <h3># q3-launch</h3>
    <p>Northwind, exported 2026-10-14</p>
  </header>
  <p class="day">Tuesday, September 2, 2026</p>
  <div class="msg">
    <span class="avatar" style="--c:#6b46c1">PS</span>
    <div>
      <p class="msg-meta"><b>Priya Shah</b> <time>10:14</time></p>
      <p>Final logo files are in the drive. Can someone check the dark variant before Friday?</p>
      <div class="image" role="img" aria-label="northwind-logo-dark.png">N</div>
      <div class="reply msg">
        <span class="avatar" style="--c:#0f7a5f">ML</span>
        <div>
          <p class="msg-meta"><b>Marcus Lee</b> <time>10:21</time></p>
          <p>Looks right. The wordmark spacing is fixed too.</p>
        </div>
      </div>
    </div>
  </div>
  <div class="msg">
    <span class="avatar" style="--c:#0f7a5f">ML</span>
    <div>
      <p class="msg-meta"><b>Marcus Lee</b> <time>10:58</time></p>
      <p>I'll post the announcement Monday morning.</p>
    </div>
  </div>
  <div class="msg">
    <span class="avatar" style="--c:#b3412b">DO</span>
    <div>
      <p class="msg-meta"><b>Dana Ortiz</b> <time>11:03</time></p>
      <p>Approved. Shipping it 🎉</p>
      <span class="reaction">🎉 3</span>
    </div>
  </div>
</article>`;

  const pdf = `<div class="as-pdf">
  <div class="page">
    <h3># q3-launch</h3>
    <p class="page-meta">Northwind, exported 2026-10-14</p>
    <div class="entry">
      <p><b>Priya Shah</b>, Sep 2, 10:14</p>
      <p>Final logo files are in the drive. Can someone check the dark variant before Friday?</p>
      <div class="image" role="img" aria-label="northwind-logo-dark.png">N</div>
      <div class="reply">
        <p><b>Marcus Lee</b>, 10:21</p>
        <p>Looks right. The wordmark spacing is fixed too.</p>
      </div>
    </div>
    <div class="entry">
      <p><b>Marcus Lee</b>, 10:58</p>
      <p>I'll post the announcement Monday morning.</p>
    </div>
    <div class="entry">
      <p><b>Dana Ortiz</b>, 11:03</p>
      <p>Approved. Shipping it 🎉</p>
    </div>
    <p class="page-foot">Page 1 of 1</p>
  </div>
</div>`;

  const formats = {
    md: { file: `${base}.md`, body: md, note: "Free. A single .md file, readable in any editor." },
    csv: { file: `${base}.csv`, body: csv, note: "Free. One row per message, ready for a spreadsheet." },
    html: {
      file: `${base}.zip / export.html`,
      body: html,
      note: "Full export. A ZIP with the page, images, avatars, and attached files.",
    },
    pdf: {
      file: `${base}.zip / export.pdf`,
      body: pdf,
      note: "Full export. Real, searchable text with images inline.",
    },
  };

  const fileEl = demo.querySelector("[data-file]");
  const nameEl = demo.querySelector("[data-file-name]");
  const bodyEl = demo.querySelector("[data-file-body]");
  const noteEl = demo.querySelector("[data-note]");
  const progressEl = demo.querySelector("[data-progress]");
  const exportBtn = demo.querySelector("[data-export]");
  const exportLabel = demo.querySelector("[data-export-label]");
  const formatBtns = [...demo.querySelectorAll("[data-format]")];

  let current = "md";
  let run = 0;

  function show(key) {
    const f = formats[key];
    nameEl.textContent = f.file;
    bodyEl.innerHTML = f.body;
    bodyEl.scrollTop = 0;
    bodyEl.scrollLeft = 0;
    noteEl.textContent = f.note;
  }

  function exportAs(key) {
    current = key;
    formatBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.format === key)));

    const id = ++run;
    if (reduceMotion.matches) {
      show(key);
      return;
    }

    const duration = 900;
    const start = performance.now();
    fileEl.classList.add("is-busy");
    exportBtn.setAttribute("aria-busy", "true");

    const tick = (now) => {
      if (id !== run) return;
      const p = Math.min((now - start) / duration, 1);
      progressEl.style.setProperty("--p", p);
      exportLabel.textContent = p < 1 ? `Exporting... ${Math.round(p * 100)}%` : "Export";
      if (p < 1) {
        requestAnimationFrame(tick);
        return;
      }
      show(key);
      fileEl.classList.remove("is-busy");
      exportBtn.removeAttribute("aria-busy");
      setTimeout(() => {
        if (id === run) progressEl.style.setProperty("--p", 0);
      }, 250);
    };
    requestAnimationFrame(tick);
  }

  formatBtns.forEach((b) => b.addEventListener("click", () => exportAs(b.dataset.format)));
  exportBtn.addEventListener("click", () => exportAs(current));
})();
