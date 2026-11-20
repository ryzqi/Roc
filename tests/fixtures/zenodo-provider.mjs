import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

/** Isolated official-response fixture; never calls a remote provider. */
export function zenodoProviderFixture(token) {
  const fixture = {calls: [], records: new Map(), uploads: [], override: null};
  let nextId = 1234, modified = 0;
  fixture.touch = record => {record.modified = new Date(Date.UTC(2026, 10, 6, 0, 0, ++modified)).toISOString();};
  fixture.fetch = async (value, init) => {
    const url = new URL(value);
    assert.equal(url.origin, 'https://sandbox.zenodo.org');
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token}`);
    fixture.calls.push({method: init.method, pathname: url.pathname, query: url.search});
    const respond = async () => {
      if (url.pathname === '/api/deposit/depositions' && init.method === 'POST') {
        const record = {id: ++nextId, owner: 77, modified: '', state: 'inprogress', submitted: false,
          metadata: JSON.parse(init.body).metadata, files: [],
          links: {bucket: `https://sandbox.zenodo.org/api/files/00000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`}};
        fixture.touch(record); fixture.records.set(record.id, record);
        return Response.json(record, {status: 201});
      }
      if (url.pathname === '/api/deposit/depositions' && init.method === 'GET') {
        const page = Number(url.searchParams.get('page')), size = Number(url.searchParams.get('size'));
        assert.equal(url.searchParams.get('all_versions'), '1');
        return Response.json([...fixture.records.values()].slice((page - 1) * size, page * size));
      }
      const get = /^\/api\/deposit\/depositions\/(\d+)$/u.exec(url.pathname);
      if (get && init.method === 'GET') return Response.json(fixture.records.get(Number(get[1])));
      if (url.pathname.startsWith('/api/files/') && init.method === 'PUT') {
        const record = [...fixture.records.values()].find(record => value.startsWith(`${record.links.bucket}/`));
        assert.ok(record);
        const name = url.pathname.split('/').at(-1), bytes = Buffer.from(await new Response(init.body).arrayBuffer());
        assert.equal(new Headers(init.headers).get('content-length'), String(bytes.length));
        assert.equal(new Headers(init.headers).get('content-type'), 'application/octet-stream');
        const md5 = createHash('md5').update(bytes).digest('hex');
        record.files.push({id: `file-${record.files.length + 1}`, filename: name, filesize: bytes.length, checksum: md5});
        fixture.uploads.push({name, bytes});
        fixture.touch(record);
        return Response.json({key: name, size: bytes.length, checksum: `md5:${md5}`});
      }
      const publish = /^\/api\/deposit\/depositions\/(\d+)\/actions\/publish$/u.exec(url.pathname);
      if (publish && init.method === 'POST') {
        const record = fixture.records.get(Number(publish[1]));
        record.state = 'done'; record.submitted = true; record.doi = `10.5072/zenodo.${record.id}`;
        record.record_id = record.id; record.record_url = `https://sandbox.zenodo.org/records/${record.id}`;
        fixture.touch(record);
        return Response.json(record, {status: 202});
      }
      throw new Error(`unexpected_fixture_request:${init.method}:${url.pathname}`);
    };
    return fixture.override === null ? respond() : fixture.override(url, init, respond);
  };
  return fixture;
}
