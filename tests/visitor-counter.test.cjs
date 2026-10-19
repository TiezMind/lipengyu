const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.match(/<script id="visitor-counter-script">([\s\S]*?)<\/script>/)[1];
const pageUrl = 'https://tiezmind.github.io/lipengyu/';

async function run(options = {}) {
  const elements = {
    'visitor-stats': {
      dataset: { page: pageUrl },
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; }
    },
    'page-view-count': { textContent: '--' }
  };
  const requests = [];
  let storageAccesses = 0;
  let timeout;
  let cleared = false;
  const context = {
    document: { getElementById: id => elements[id] },
    window: { location: new URL(options.url || pageUrl) },
    URL, AbortController, Intl,
    get localStorage() {
      storageAccesses++;
      throw new Error('Counter must not access browser storage');
    },
    setTimeout(callback, milliseconds) {
      assert.equal(milliseconds, 8000);
      timeout = callback;
      return 1;
    },
    clearTimeout(id) {
      assert.equal(id, 1);
      cleared = true;
    },
    async fetch(url, init) {
      requests.push({ url, ...init });
      if (options.pending) {
        return new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('Aborted')));
        });
      }
      if (options.networkError) throw new Error('Network error');
      return {
        ok: options.httpOk !== false,
        async json() {
          if (options.invalidJson) throw new SyntaxError('Invalid JSON');
          return Object.hasOwn(options, 'result') ? options.result : {
            success: true,
            data: { page_uv: 1234, page_pv: 5678, site_uv: 9999, site_pv: 99999 }
          };
        }
      };
    }
  };
  vm.runInNewContext(source, context);
  if (options.pending) timeout();
  await new Promise(resolve => setImmediate(resolve));
  return { elements, requests, storageAccesses, cleared };
}

test('uses only page views and preserves the canonical page key', async () => {
  const { elements, requests, storageAccesses, cleared } = await run();
  assert.equal(elements['page-view-count'].textContent, '5,678');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://bsz.iirose.cn/api');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers['x-bsz-referer'], pageUrl);
  assert.equal(requests[0].headers.Authorization, undefined);
  assert.equal(requests[0].credentials, 'omit');
  assert.equal(requests[0].referrerPolicy, 'no-referrer');
  assert.equal(storageAccesses, 0);
  assert.match(elements['visitor-stats'].title, /Total page views, including repeat visits/);
  assert.equal(elements['visitor-stats'].attributes['aria-busy'], 'false');
  assert.equal(cleared, true);
});

test('normalizes index.html, trailing slash, query, and fragment variants', async () => {
  for (const url of [pageUrl, pageUrl.slice(0, -1), pageUrl + 'index.html', pageUrl + '?from=cv#news']) {
    const { requests } = await run({ url });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers['x-bsz-referer'], pageUrl);
    assert.equal(requests[0].headers.Authorization, undefined);
  }
});

test('does not count local previews, mirrors, or unrelated project pages', async () => {
  for (const url of [
    'file:///tmp/homepage/index.html', 'http://localhost:8000/lipengyu/',
    'http://127.0.0.1:8000/', 'https://example.com/lipengyu/',
    'https://tiezmind.github.io/', pageUrl + 'other.html'
  ]) {
    const { elements, requests, cleared } = await run({ url });
    assert.equal(requests.length, 0);
    assert.equal(cleared, false);
    assert.equal(elements['page-view-count'].textContent, '--');
    assert.match(elements['visitor-stats'].title, /published homepage/);
  }
});

test('does not depend on unique visitor counts', async () => {
  for (const data of [
    { page_pv: 5 },
    { page_pv: 5, page_uv: -1 },
    { page_pv: 5, page_uv: 'invalid' }
  ]) {
    const { elements } = await run({ result: { success: true, data } });
    assert.equal(elements['page-view-count'].textContent, '5');
  }
});

test('displays real zero counts', async () => {
  const { elements } = await run({ result: { success: true, data: { page_pv: 0 } } });
  assert.equal(elements['page-view-count'].textContent, '0');
});

test('fails gracefully without fake counts or retries', async () => {
  for (const options of [
    { networkError: true }, { httpOk: false }, { invalidJson: true }, { pending: true },
    { result: null }, { result: { success: false } },
    { result: { success: true, data: {} } },
    { result: { success: true, data: { page_pv: -5 } } },
    { result: { success: true, data: { page_pv: '5' } } },
    { result: { success: true, data: { page_pv: 1.5 } } },
    { result: { success: true, data: { page_pv: Number.MAX_SAFE_INTEGER + 1 } } }
  ]) {
    const { elements, requests, storageAccesses, cleared } = await run(options);
    assert.equal(elements['page-view-count'].textContent, '--');
    assert.match(elements['visitor-stats'].title, /temporarily unavailable/);
    assert.equal(elements['visitor-stats'].attributes['aria-busy'], 'false');
    assert.equal(requests.length, 1);
    assert.equal(storageAccesses, 0);
    assert.equal(cleared, true);
  }
});
