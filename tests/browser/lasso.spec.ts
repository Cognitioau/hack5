import { test, expect, type Page } from '@playwright/test';
import {
  configureVault,
  drawCircle,
  launchExtension,
  state,
  wake,
  type ExtensionFixture,
} from './helpers/extension-fixture';
import { startVaultFixture } from './helpers/vault-fixture';

const steps = [
  'Open the Activity Monitor from the Utilities folder and look for the process named in the warning, then select it and choose Quit from the toolbar.',
  'Restart the menu bar helper by holding Option while clicking its icon. That resets its preferences but keeps every shortcut you have set up.',
  'Remove the login item from System Settings under General, then sign out and back in so the change takes effect for every account.',
];
const dense = Array.from(
  { length: 12 },
  (_, index) =>
    `Sentence ${index + 1} of the notes talks about camera bundles and the shipping times for most orders.`,
);
// Short sentences, where a small circle's rim crosses whole sentences on the lines above and below.
const terse = Array.from({ length: 30 }, (_, index) =>
  index % 3 === 0
    ? `Step ${index + 1} ships.`
    : index % 3 === 1
      ? `Step ${index + 1} waits for the lens kit.`
      : `Step ${index + 1} packs the camera bag and strap.`,
);
const boxes = Array.from(
  { length: 30 },
  (_, index) => `Box ${index + 1} goes on the shelf, as is.`,
);
// Set in monospace, so its lines break in the same places under any platform's fonts.
const columnHtml = `<!doctype html><meta charset="utf-8"><title>Helper notes</title>
  <style>body { font: 16px/24px monospace; margin: 320px 0 400px 180px; width: 640px } section { margin-bottom: 140px }</style>
  <section><h2 id="title">What to do if it won't stop</h2>
  <ol id="steps">${steps.map((step) => `<li>${step}</li>`).join('')}</ol>
  <p id="next">${dense.slice(0, 6).join(' ')}</p></section>
  <section><ul id="ways"><li>Menu Bar Button</li><li>Keyboard Shortcut</li><li>Hot Corner</li></ul></section>
  <section><ul id="pair" style="padding-left: 300px; margin-bottom: 0"><li>Menu Bar Button</li><li>Hot Corner</li></ul>
  <p id="below" style="margin-top: 0">A paragraph sits right below them. Go now. Then the rest of it carries on past the list.</p></section>
  <section><p id="boxes">${boxes.join(' ')}</p></section>
  <section><p id="link">Read the <a href="/guide">setup guide for the helper</a> before you begin, as it lists every shortcut.</p></section>`;

// Notes and links in every sentence, as an encyclopaedia sets them.
const facts = Array.from(
  { length: 18 },
  (_, index) =>
    `Fact ${index + 1} about the camera kit is in the notes[${index + 100}] for the kit.`,
);
const cited = facts
  .map((fact, index) =>
    fact
      .replace('camera kit', '<a href="/kit">camera kit</a>')
      .replace(`[${index + 100}]`, `<sup><a href="#n${index}">[${index + 100}]</a></sup>`),
  )
  .join(' ');
const detail = Array.from(
  { length: 14 },
  (_, index) =>
    `Sentence ${index + 1} explains a detail about the camera kit and how the parts fit together.`,
);
const points = (part: number) =>
  Array.from(
    { length: 8 },
    (_, index) => `Point ${part}.${index + 1} covers how the camera kit is packed and sent.`,
  );
// Highlighted code: many elements to a line, too many to read the block whole.
const code = Array.from(
  { length: 160 },
  (_, line) => `<span>L${line}</span>${' <i>x</i>'.repeat(30)}`,
).join('\n');
const textHtml = `<!doctype html><meta charset="utf-8"><title>Kit notes</title>
  <style>body { font: 16px/24px monospace; margin: 320px 0 400px 180px; width: 640px } section { margin-bottom: 140px }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0 }
  td { padding: 1px 4px }</style>
  <section><p id="cited">${cited}</p></section>
  <section><p id="detail">${detail.join(' ')}</p>
  <p id="tail">Next paragraph starts here with a short line. And then it carries on for a while longer so it wraps across the page and past.</p></section>
  <section><p id="first">${points(1).join(' ')}</p><p id="second">${points(2).join(' ')}</p></section>
  <section><nav id="crumbs"><a href="/">Home page of the shop</a> › <a href="/cameras">Cameras and lenses</a></nav>
  <ul id="todo"><li>Ship the kit by Friday. <details><summary>Why</summary>The reason stays folded away.</details></li>
  <li>Email the buyer <span class="sr-only">(opens in a new tab)</span>the tracking number.</li></ul></section>
  <section><ul id="cards"><li><div>Canon EOS R8</div><div>Full-frame body with a fast autofocus system.</div><div>$1,499</div></li>
  <li><div>Nikon Z6 III</div><div>Partly stacked sensor for quick readout.</div><div>$2,499</div></li></ul></section>
  <section><table id="grid">${Array.from(
    { length: 12 },
    (_, row) =>
      `<tr>${Array.from({ length: 11 }, (_, column) => `<td>c${row * 11 + column + 1}</td>`).join('')}</tr>`,
  ).join('')}</table></section>
  <section><pre id="code" style="font: 12px/14px monospace">${code}</pre></section>`;

// Sections sit far apart, so a loop drawn generously round one stays clear of the others.
const stepsHtml = `<!doctype html><meta charset="utf-8"><title>Stop a stuck helper</title>
  <style>body { font: 16px/24px sans-serif; margin: 320px 0 400px 180px; width: 640px } section { margin-bottom: 140px } h2 { margin-bottom: 48px }</style>
  <section><h2 id="heading">What to do if it won't stop</h2>
  <ol id="steps">${steps.map((step) => `<li>${step}</li>`).join('')}</ol></section>
  <section><p id="after" style="width: 420px">A paragraph on its own, with a <button>Copy</button> button, <span aria-hidden="true">a hidden aside,</span> and a field: <input value="A form field must never be captured"></p></section>
  <section><p id="dense">${dense.join(' ')}</p></section>
  <section><p id="terse">${terse.join(' ')}</p></section>`;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where the text (or picture) of everything `selector` matches lies on screen,
 * centred in view. Any scroll ends an aimed lasso, so this waits until the
 * page has had its scroll event before anything is drawn.
 */
async function textBox(page: Page, selector: string): Promise<Box> {
  return page.evaluate(async (selector) => {
    // The words' own boxes: a range over a block holding blocks would span their full width.
    const measure = (): DOMRect[] =>
      [...document.querySelectorAll(selector)].flatMap((element) => {
        if (element instanceof HTMLImageElement) return [element.getBoundingClientRect()];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const boxes: DOMRect[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          // Text a page folds away has no box.
          const box = range.getBoundingClientRect();
          if (box.width > 0 && box.height > 0) boxes.push(box);
        }
        return boxes;
      });
    const union = (boxes: DOMRect[]) => ({
      left: Math.min(...boxes.map((box) => box.left)),
      top: Math.min(...boxes.map((box) => box.top)),
      right: Math.max(...boxes.map((box) => box.right)),
      bottom: Math.max(...boxes.map((box) => box.bottom)),
    });
    const first = measure();
    if (!first.length) throw new Error(`Nothing matches ${selector}`);
    const before = union(first);
    window.scrollBy({
      top: (before.top + before.bottom) / 2 - innerHeight / 2,
      behavior: 'instant',
    });
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    return union(measure());
  }, selector);
}

/**
 * A loop round a box, as a hand draws one: an oval through its corners, a
 * little outside them, and never so flat that it is no loop at all.
 */
async function loopRound(page: Page, box: Box, modifier: 'Shift' | 'Control' = 'Shift') {
  const center = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
  const across = ((box.right - box.left) / 2) * Math.SQRT2 + 10;
  const down = Math.max(((box.bottom - box.top) / 2) * Math.SQRT2 + 10, across / 2.5);
  await drawCircle(page, center, modifier, 1, { x: across, y: down });
}

/** The middle of a sentence's longest line, with a line of the same paragraph above and below it. */
async function aimAt(page: Page, selector: string, sentence: string) {
  await textBox(page, selector);
  return page.evaluate(
    ({ selector, sentence }) => {
      const text = document.querySelector(selector)?.firstChild as Text;
      const range = document.createRange();
      const start = text.data.indexOf(sentence);
      range.setStart(text, start);
      range.setEnd(text, start + sentence.length);
      const [line] = Array.from(range.getClientRects()).sort((a, b) => b.width - a.width);
      if (!line) throw new Error('Sentence not laid out');
      const aim = { x: line.left + Math.min(line.width / 2, 120), y: line.top + line.height / 2 };
      for (const y of [aim.y - line.height, aim.y + line.height])
        if (document.caretPositionFromPoint(aim.x, y)?.offsetNode !== text)
          throw new Error('The sentence needs a line of its paragraph above and below');
      return aim;
    },
    { selector, sentence },
  );
}

/**
 * The boxes the hand lights while a loop is drawn, read through the browser's
 * protocol, which reaches into the hand's closed shadow root.
 */
async function lit(page: Page): Promise<Box[]> {
  type Node = {
    nodeId: number;
    attributes?: string[];
    children?: Node[];
    shadowRoots?: Node[];
  };
  const client = await page.context().newCDPSession(page);
  try {
    const { root } = (await client.send('DOM.getDocument', { depth: -1, pierce: true })) as {
      root: Node;
    };
    const targets: number[] = [];
    const walk = (node: Node, inHand: boolean): void => {
      const attributes = node.attributes ?? [];
      const named = (name: string) => attributes[attributes.indexOf(name) + 1] ?? '';
      if (inHand && attributes.includes('class') && named('class').split(' ').includes('target'))
        targets.push(node.nodeId);
      const hand = inHand || attributes.includes('data-zombie-hand-ui');
      for (const child of node.children ?? []) walk(child, hand);
      for (const shadow of node.shadowRoots ?? []) walk(shadow, hand);
    };
    walk(root, false);
    const boxes: Box[] = [];
    for (const nodeId of targets) {
      const result = (await client.send('DOM.getBoxModel', { nodeId }).catch(() => null)) as {
        model: { border: number[] };
      } | null;
      const [left = 0, top = 0, , , right = 0, bottom = 0] = result?.model.border ?? [];
      if (right > left && bottom > top) boxes.push({ left, top, right, bottom });
    }
    return boxes;
  } finally {
    await client.detach();
  }
}

/** The lines a paragraph's words lie on, one box each, as Chrome lays them out. */
async function lines(page: Page, selector: string): Promise<Box[]> {
  return page.evaluate((selector) => {
    const element = document.querySelector(selector);
    const walker = document.createTreeWalker(element ?? document, NodeFilter.SHOW_TEXT);
    const rows: { left: number; top: number; right: number; bottom: number }[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const box of range.getClientRects()) {
        if (box.width <= 0 || !node.textContent?.trim()) continue;
        const row = rows.find(
          (other) => Math.abs(other.top + other.bottom - box.top - box.bottom) < box.height,
        );
        if (row) {
          row.left = Math.min(row.left, box.left);
          row.right = Math.max(row.right, box.right);
        } else rows.push({ left: box.left, top: box.top, right: box.right, bottom: box.bottom });
      }
    }
    return rows;
  }, selector);
}

const seen = new Set<string>();

/** The capture just taken, once the vault has it and the hand has settled. */
async function saved(fixture: ExtensionFixture, page: Page, count: number) {
  await expect
    .poll(async () => (await state(fixture)).map((capture) => capture.persistence))
    .toEqual(Array.from({ length: count }, () => 'saved-vault'));
  await page.waitForTimeout(2_500);
  const fresh = (await state(fixture)).filter((capture) => !seen.has(capture.id));
  expect(fresh).toHaveLength(1);
  for (const capture of fresh) seen.add(capture.id);
  return fresh[0];
}

test('a lasso takes what its loop goes round: steps by their starts, a heading with them, one sentence, never a control', async () => {
  test.setTimeout(150_000);
  const vault = await startVaultFixture();
  const fixture = await launchExtension('full');
  try {
    await configureVault(fixture, vault, false);
    const url = `${vault.origin}/steps`;
    await fixture.context.route(url, (route) =>
      route.fulfill({ contentType: 'text/html', body: stepsHtml }),
    );
    const page = await fixture.context.newPage();
    await page.goto(url);
    await wake(fixture, page);

    // Round the start of each step only, as in a quick loop down a list:
    // every step is taken, whole and in order, a blank line between them.
    const list = await textBox(page, '#steps li');
    await loopRound(page, { ...list, right: list.left + 200 });
    const byStarts = await saved(fixture, page, 1);
    expect(byStarts?.candidate).toEqual({
      kind: 'text',
      url,
      title: 'Stop a stuck helper',
      text: steps.join('\n\n'),
      context: { heading: "What to do if it won't stop" },
      passageUrl: `${url}#:~:text=Open%20the%20Activity%20Monitor,effect%20for%20every%20account.`,
    });
    const note = vault.files.get(`Zombie Hand/captures/${byStarts?.id}.md`)?.toString() ?? '';
    for (const step of steps) expect(note).toContain(step);

    // Wider than any loop the lasso closed before: the heading and every step.
    const section = await textBox(page, '#heading, #steps li');
    expect(section.right - section.left).toBeGreaterThan(440);
    await loopRound(page, section, 'Control');
    expect((await saved(fixture, page, 2))?.candidate.text).toBe(
      ["What to do if it won't stop", ...steps].join('\n\n'),
    );

    // A paragraph holding a button, a hidden aside and a form field: only its words.
    await loopRound(page, await textBox(page, '#after'));
    expect((await saved(fixture, page, 3))?.candidate.text).toBe(
      'A paragraph on its own, with a button, and a field:',
    );

    // A small circle on one sentence of a paragraph, its rim across the lines
    // above and below: that sentence alone, long or short.
    await drawCircle(page, await aimAt(page, '#dense', dense[4] ?? ''), 'Shift');
    expect((await saved(fixture, page, 4))?.candidate.text).toBe(dense[4]);
    await drawCircle(page, await aimAt(page, '#terse', terse[16] ?? ''), 'Shift');
    expect((await saved(fixture, page, 5))?.candidate.text).toBe(terse[16]);

    // Words already highlighted under the loop's centre are taken as they
    // are, however much more the loop goes round.
    const highlighted = 'talks about camera bundles';
    await textBox(page, '#dense');
    const middle = await page.evaluate((words) => {
      const text = document.querySelector('#dense')?.firstChild as Text;
      const start = text.data.indexOf(words, text.data.indexOf('Sentence 7 '));
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + words.length);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      const [line] = Array.from(range.getClientRects()).sort((a, b) => b.width - a.width);
      if (!line) throw new Error('Selection not laid out');
      return { x: line.left + line.width / 2, y: line.top + line.height / 2 };
    }, highlighted);
    await loopRound(page, {
      left: middle.x - 160,
      top: middle.y - 50,
      right: middle.x + 160,
      bottom: middle.y + 50,
    });
    expect((await saved(fixture, page, 6))?.candidate.text).toBe(highlighted);
  } finally {
    await fixture.close();
    await vault.close();
  }
});

test('a lasso keeps to the lines it holds: corners cut, a short list, a line it only crosses, a few lines round a sentence, a link', async () => {
  test.setTimeout(150_000);
  const vault = await startVaultFixture();
  const fixture = await launchExtension('full');
  try {
    await configureVault(fixture, vault, false);
    const url = `${vault.origin}/column`;
    await fixture.context.route(url, (route) =>
      route.fulfill({ contentType: 'text/html', body: columnHtml }),
    );
    const page = await fixture.context.newPage();
    await page.goto(url);
    await wake(fixture, page);

    // An oval over the left of the steps, its rim cutting into the first
    // words of the top and bottom lines: still every step.
    const list = await textBox(page, '#steps li');
    await drawCircle(page, { x: list.left + 80, y: (list.top + list.bottom) / 2 }, 'Shift', 1, {
      x: 100,
      y: (list.bottom - list.top) / 2 + 20,
    });
    expect((await saved(fixture, page, 1))?.candidate.text).toBe(steps.join('\n\n'));

    // Snug round the heading and the steps, the oval bulging across the
    // paragraph right below them: the heading and the steps, nothing of it.
    await loopRound(page, await textBox(page, '#title, #steps li'));
    expect((await saved(fixture, page, 2))?.candidate.text).toBe(
      ["What to do if it won't stop", ...steps].join('\n\n'),
    );

    // Round a short list: each item, linked back from the first to the last.
    await loopRound(page, await textBox(page, '#ways li'));
    expect((await saved(fixture, page, 3))?.candidate).toMatchObject({
      text: 'Menu Bar Button\n\nKeyboard Shortcut\n\nHot Corner',
      passageUrl: `${url}#:~:text=Menu%20Bar%20Button,Hot%20Corner`,
    });

    // Round two items, its bottom across the middle of the line below them,
    // far from that line's start: the items, and nothing of that line.
    await textBox(page, '#pair li, #below');
    const pair = await textBox(page, '#pair li');
    const under = await page.evaluate(() => {
      const text = document.querySelector('#below')?.firstChild as Text;
      const range = document.createRange();
      range.setStart(text, text.data.indexOf('Go now.'));
      range.setEnd(text, text.data.indexOf('Go now.') + 'Go now.'.length);
      return range.getBoundingClientRect().toJSON() as Box;
    });
    const centre = { x: (pair.left + pair.right) / 2, y: (pair.top + pair.bottom) / 2 };
    expect(under.left).toBeGreaterThan(centre.x - 100);
    expect(under.right).toBeLessThan(centre.x + 100);
    await drawCircle(page, centre, 'Shift', 1, { x: 120, y: under.bottom + 8 - centre.y });
    expect((await saved(fixture, page, 4))?.candidate.text).toBe('Menu Bar Button\n\nHot Corner');

    // Three lines tall, centred on the first word of a sentence that starts
    // mid-line: that sentence, though the loop holds the end of the one before.
    await textBox(page, '#boxes');
    const aim = await page.evaluate((boxes) => {
      const paragraph = document.querySelector('#boxes');
      const text = paragraph?.firstChild as Text;
      const edges = paragraph?.getBoundingClientRect();
      for (const index of [12, 13, 14, 15, 16]) {
        const start = text.data.indexOf(boxes[index] ?? '');
        const range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, start + 3);
        const word = range.getBoundingClientRect();
        if (edges && word.left - edges.left > 160 && edges.right - word.left > 160)
          return { index, x: word.left + word.width / 2, y: word.top + word.height / 2 };
      }
      throw new Error('No sentence starts mid-line');
    }, boxes);
    await drawCircle(page, aim, 'Shift', 1, { x: 130, y: 46 });
    expect((await saved(fixture, page, 5))?.candidate.text).toBe(boxes[aim.index]);

    // A small circle on a link takes the link.
    const link = await textBox(page, '#link a');
    await drawCircle(
      page,
      { x: (link.left + link.right) / 2, y: (link.top + link.bottom) / 2 },
      'Shift',
    );
    expect((await saved(fixture, page, 6))?.candidate).toMatchObject({
      kind: 'link',
      url: `${vault.origin}/guide`,
      text: 'setup guide for the helper',
    });
  } finally {
    await fixture.close();
    await vault.close();
  }
});

test('a lasso lights every line it takes and takes what it goes round across blocks, never folded, clipped or navigation text', async () => {
  test.setTimeout(240_000);
  // Each save is held open a moment, so what the hand lights as it takes a passage can be read.
  const vault = await startVaultFixture({ writeDelayMs: 1_500 });
  const fixture = await launchExtension('full');
  try {
    await configureVault(fixture, vault, false);
    const url = `${vault.origin}/notes`;
    await fixture.context.route(url, (route) =>
      route.fulfill({ contentType: 'text/html', body: textHtml }),
    );
    const page = await fixture.context.newPage();
    await page.goto(url);
    await wake(fixture, page);

    // A paragraph thick with links and notes: as it is taken, every line of
    // it is lit, the last as well as the first.
    const paragraph = await textBox(page, '#cited');
    const rows = await lines(page, '#cited');
    expect(rows.length).toBeGreaterThan(12);
    await loopRound(page, paragraph);
    const boxes = await lit(page);
    for (const row of rows) {
      // Lit across its whole width, by one box or several side by side.
      let reached = row.left;
      for (const box of boxes
        .filter((box) => box.top <= row.top + 2 && box.bottom >= row.bottom - 2)
        .sort((a, b) => a.left - b.left))
        if (box.left <= reached + 2) reached = Math.max(reached, box.right);
      expect(reached, `line at ${Math.round(row.top)} is lit to its end`).toBeGreaterThanOrEqual(
        row.right - 2,
      );
    }
    expect((await saved(fixture, page, 1))?.candidate.text).toBe(facts.join(' '));

    // Over the middle of a paragraph, far from its lines' starts, its rim
    // across the first line of the next: the sentences it goes round, and
    // nothing of the next paragraph.
    const middle = await textBox(page, '#detail');
    await drawCircle(
      page,
      { x: (middle.left + middle.right) / 2, y: middle.bottom - 50 },
      'Shift',
      1,
      { x: 200, y: 115 },
    );
    const over = (await saved(fixture, page, 2))?.candidate.text ?? '';
    expect(detail.join(' ')).toContain(over);
    expect(over.match(/Sentence \d+ /gu)?.length ?? 0).toBeGreaterThanOrEqual(3);

    // Centred in the gap between two paragraphs, over neither's lines'
    // starts: sentences of both.
    const pair = await textBox(page, '#first, #second');
    const gap = await page.evaluate(() => {
      const above = document.querySelector('#first')?.getBoundingClientRect();
      const below = document.querySelector('#second')?.getBoundingClientRect();
      return above && below ? (above.bottom + below.top) / 2 : 0;
    });
    expect(gap).toBeGreaterThan(pair.top);
    await drawCircle(page, { x: (pair.left + pair.right) / 2, y: gap }, 'Shift', 1, {
      x: 250,
      y: 100,
    });
    const both = (await saved(fixture, page, 3))?.candidate.text.split('\n\n') ?? [];
    expect(both).toHaveLength(2);
    expect(points(1).join(' ')).toContain(both[0] ?? '-');
    expect(points(2).join(' ')).toContain(both[1] ?? '-');
    expect(both[0]?.match(/Point 1\.\d/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);

    // Round a trail of links and a list: the items, never the navigation, an
    // answer folded away in a closed details or words kept for screen readers.
    await loopRound(page, await textBox(page, '#crumbs, #todo li'));
    expect((await saved(fixture, page, 4))?.candidate.text).toBe(
      'Ship the kit by Friday.\n\nEmail the buyer the tracking number.',
    );

    // Cards set in rows of plain blocks: their words apart, and a link back
    // that opens the page at them.
    await loopRound(page, await textBox(page, '#cards li'));
    const cards = await saved(fixture, page, 5);
    expect(cards?.candidate).toMatchObject({
      text: 'Canon EOS R8 Full-frame body with a fast autofocus system. $1,499\n\nNikon Z6 III Partly stacked sensor for quick readout. $2,499',
      passageUrl: `${url}#:~:text=Canon%20EOS%20R8,%242%2C499`,
    });
    const opened = await fixture.context.newPage();
    await opened.goto(cards?.candidate.passageUrl ?? url);
    await expect.poll(() => opened.evaluate(() => scrollY), { timeout: 5_000 }).toBeGreaterThan(0);
    await opened.close();

    // Round more cells than a loop reads: the first it reads, marked cut short.
    await loopRound(page, await textBox(page, '#grid td'));
    const grid = await saved(fixture, page, 6);
    expect(grid?.candidate.truncated).toBe(true);
    expect(grid?.candidate.text.split('\n\n')).toHaveLength(120);

    // Round forty lines of code too large to read whole: each line once.
    await textBox(page, '#code');
    const block = await page.evaluate(() => {
      const spans = [...document.querySelectorAll('#code span')];
      const top = spans[60]?.getBoundingClientRect();
      const bottom = spans[99]?.getBoundingClientRect();
      const pre = document.querySelector('#code span')?.parentElement?.getBoundingClientRect();
      if (!top || !bottom || !pre) throw new Error('Code not laid out');
      return { left: pre.left, top: top.top, right: pre.left + 450, bottom: bottom.bottom };
    });
    await drawCircle(
      page,
      { x: (block.left + block.right) / 2, y: (block.top + block.bottom) / 2 },
      'Shift',
      1,
      { x: (block.right - block.left) / 2 + 60, y: (block.bottom - block.top) / 2 + 24 },
    );
    const taken = (await saved(fixture, page, 7))?.candidate.text ?? '';
    for (let line = 0; line < 160; line++)
      expect(taken.split(`L${line} `).length - 1, `line ${line} at most once`).toBeLessThanOrEqual(
        1,
      );
    for (let line = 66; line <= 93; line++) expect(taken).toContain(`L${line} `);
  } finally {
    await fixture.close();
    await vault.close();
  }
});

test('in the core build, a lasso centred on a picture reads the text round it', async () => {
  test.setTimeout(120_000);
  const vault = await startVaultFixture();
  const fixture = await launchExtension('core');
  try {
    await configureVault(fixture, vault, false);
    const url = `${vault.origin}/figure`;
    await fixture.context.route(url, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta charset="utf-8"><title>A fern</title>
          <style>body { font: 16px/24px monospace; margin: 320px 0 400px 180px; width: 640px }</style>
          <p id="above">The fern grows in shade and needs water every week.</p>
          <p><img id="fern" src="/fern.png" width="120" height="90" alt="A fern"></p>
          <p id="below">Its fronds unroll in spring and turn brown by winter.</p>`,
      }),
    );
    const page = await fixture.context.newPage();
    await page.goto(url);
    await wake(fixture, page);
    await loopRound(page, await textBox(page, '#above, #fern, #below'));
    expect((await saved(fixture, page, 1))?.candidate).toMatchObject({
      kind: 'text',
      text: 'The fern grows in shade and needs water every week.\n\nIts fronds unroll in spring and turn brown by winter.',
    });
  } finally {
    await fixture.close();
    await vault.close();
  }
});

test('a lasso round search results takes each result whole, in order, and nothing beyond them', async () => {
  test.setTimeout(120_000);
  const vault = await startVaultFixture();
  const fixture = await launchExtension('full');
  try {
    await configureVault(fixture, vault, false);
    const url = `${vault.origin}/results`;
    const result = (id: string, title: string, address: string, snippet: string) =>
      `<div class="result" id="${id}"><a href="https://${address.split(' ')[0]}/"><h3>${title}</h3></a>
        <div class="row"><span>https://${address}</span></div>
        <div style="width: 300px"><span>${snippet}</span></div></div>`;
    await fixture.context.route(url, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta charset="utf-8"><title>camera bundles - Search</title>
          <style>body { font: 16px/24px sans-serif; margin: 320px 0 400px 180px } .row { display: flex; gap: 8px } .result { margin-bottom: 28px }</style>
          <div id="results">${result('one', 'Camera bundles - Example shop', 'shop.example › bundles', 'Explore the camera bundles at the first local store. Free shipping on <em>most</em> orders.')}
          ${result('two', 'Lens kits - Example shop', 'lens.example › kits', 'Compare lens kits for every camera body. Returns are free for thirty days.')}</div>
          <div style="margin-top: 160px">More results from shop.example</div>`,
      }),
    );
    const page = await fixture.context.newPage();
    await page.goto(url);
    await wake(fixture, page);
    await loopRound(page, await textBox(page, '.result'));
    const capture = await saved(fixture, page, 1);
    expect(capture?.candidate).toMatchObject({
      kind: 'text',
      url,
      text: [
        'Camera bundles - Example shop',
        'https://shop.example › bundles',
        'Explore the camera bundles at the first local store. Free shipping on most orders.',
        'Lens kits - Example shop',
        'https://lens.example › kits',
        'Compare lens kits for every camera body. Returns are free for thirty days.',
      ].join('\n\n'),
      passageUrl: `${url}#:~:text=Camera%20bundles%20%2D%20Example,free%20for%20thirty%20days.`,
    });
  } finally {
    await fixture.close();
    await vault.close();
  }
});

test('a lasso round a picture takes the picture, and round two the larger', async () => {
  test.setTimeout(120_000);
  const vault = await startVaultFixture();
  const fixture = await launchExtension('full');
  try {
    await configureVault(fixture, vault, false);
    const article = await fixture.context.newPage();
    await article.goto(`${vault.origin}/article`);
    await wake(fixture, article);
    await loopRound(article, await textBox(article, '#fern'));
    const fern = await saved(fixture, article, 1);
    expect(fern?.candidate).toMatchObject({
      kind: 'image',
      image: { url: `${vault.origin}/fern.png`, alt: 'A synthetic green fern specimen' },
    });

    // Centred on the gap between them, where there is nothing to take, the
    // loop holds no words, so it takes the larger picture it goes round.
    const url = `${vault.origin}/pictures`;
    await fixture.context.route(url, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta charset="utf-8"><title>Two ferns</title>
          <style>body { font: 16px/24px sans-serif; margin: 320px 0 400px 180px }</style>
          <p>Two pictures, far below.</p>
          <div id="pair" style="display: flex; align-items: center; gap: 140px; margin-top: 200px">
            <img src="/fern.png" width="90" height="90" alt="A small fern">
            <img src="/fern.png" width="180" height="140" alt="A large fern"></div>`,
      }),
    );
    const pictures = await fixture.context.newPage();
    await pictures.goto(url);
    await wake(fixture, pictures);
    await textBox(pictures, '#pair img');
    const pair = await pictures
      .locator('#pair img')
      .evaluateAll((images) =>
        images.map((image) => image.getBoundingClientRect().toJSON() as Box),
      );
    const [small, large] = pair;
    if (!small || !large) throw new Error('Missing pictures');
    const box = { left: small.left, top: large.top, right: large.right, bottom: large.bottom };
    const center = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
    expect(center.x).toBeGreaterThan(small.right);
    expect(center.x).toBeLessThan(large.left);
    await loopRound(pictures, box);
    const larger = await saved(fixture, pictures, 2);
    expect(larger?.candidate).toMatchObject({ kind: 'image', image: { alt: 'A large fern' } });
  } finally {
    await fixture.close();
    await vault.close();
  }
});
