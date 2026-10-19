const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.match(/<script id="visitor-counter-script">([\s\S]*?)<\/script>/)[1];
const pageUrl = 'https://tiezmind.github.io/lipengyu/';
const storageKey = 'homepage:busuanzi-identity';

async function run(options = {}) {
  const elements = {
    'visitor-stats': {
      dataset: { page: pageUrl },
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; }
    },
    'visitor-count': { textContent: '--' },
    'page-view-count': { textContent: '--' }
  };
  const requests = [];
  const saved = [];
  let timeout;
  let cleared = false;
  const context = {
    document: { getElementById: id => elements[id] },
    window: { location: new URL(options.url || pageUrl) },
    URL, AbortController, Intl,
    localStorage: {
      getItem(key) {
        assert.equal(key, storageKey);
        if (options.storageBlocked) throw new Error('Storage blocked');
        return options.identity || null;
      },
      setItem(key, value) {
        if (options.storageBlocked) throw new Error('Storage blocked');
        saved.push([key, value]);
      }
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
        headers: { get: name => name === 'Set-Bsz-Identity' ? 'signed-token' : null },
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
  return { elements, requests, saved, cleared };
}

test('uses page-level counts, canonical URL, and the service identity', async () => {
  const { elements, requests, saved, cleared } = await run({ identity: 'previous-token' });
  assert.equal(elements['visitor-count'].textContent, '1,234');
  assert.equal(elements['page-view-count'].textContent, '5,678');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://bsz.iirose.cn/api');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers['x-bsz-referer'], pageUrl);
  assert.equal(requests[0].headers.Authorization, 'Bearer previous-token');
  assert.equal(requests[0].credentials, 'omit');
  assert.equal(requests[0].referrerPolicy, 'no-referrer');
  assert.deepEqual(saved, [[storageKey, 'signed-token']]);
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
    assert.equal(elements['visitor-count'].textContent, '--');
    assert.match(elements['visitor-stats'].title, /published homepage/);
  }
});

test('still displays counts when browser storage is blocked', async () => {
  const { elements, requests } = await run({ storageBlocked: true });
  assert.equal(elements['visitor-count'].textContent, '1,234');
  assert.equal(requests[0].headers.Authorization, undefined);
});

test('displays real zero counts', async () => {
  const { elements } = await run({ result: { success: true, data: { page_uv: 0, page_pv: 0 } } });
  assert.equal(elements['visitor-count'].textContent, '0');
  assert.equal(elements['page-view-count'].textContent, '0');
});

test('fails gracefully without fake counts or retries', async () => {
  for (const options of [
    { networkError: true }, { httpOk: false }, { invalidJson: true }, { pending: true },
    { result: null }, { result: { success: false } },
    { result: { success: true, data: {} } },
    { result: { success: true, data: { page_uv: -1, page_pv: 5 } } },
    { result: { success: true, data: { page_uv: 1, page_pv: -5 } } },
    { result: { success: true, data: { page_uv: '1', page_pv: 5 } } },
    { result: { success: true, data: { page_uv: 1.5, page_pv: 5 } } },
    { result: { success: true, data: { page_uv: 1, page_pv: Number.MAX_SAFE_INTEGER + 1 } } }
  ]) {
    const { elements, requests, saved, cleared } = await run(options);
    assert.equal(elements['visitor-count'].textContent, '--');
    assert.equal(elements['page-view-count'].textContent, '--');
    assert.match(elements['visitor-stats'].title, /temporarily unavailable/);
    assert.equal(elements['visitor-stats'].attributes['aria-busy'], 'false');
    assert.equal(requests.length, 1);
    assert.deepEqual(saved, []);
    assert.equal(cleared, true);
  }
});
