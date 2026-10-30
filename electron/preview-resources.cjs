const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { Readable } = require('node:stream');
const { resolveProjectPath, IMAGE_TYPES, VIDEO_TYPES } = require('./project-files.cjs');

const WEB_TYPES = {
  ...IMAGE_TYPES, ...VIDEO_TYPES,
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream',
};

// Preview documents never share the privileged application's origin or preload.
// A random, short-lived host grants access only to this project's web resources.
const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'self' https: 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' https: 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "font-src 'self' https: data:",
  "connect-src 'self' https:",
  "media-src 'self' https: data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'self'",
  "sandbox allow-scripts allow-same-origin",
].join('; ');

function allowsHiddenPath(session, relativePath) {
  if (relativePath === session.filePath.replace(/\\/g, '/')) return true;
  const parts = relativePath.split(/[\\/]/);
  const selectedParents = session.filePath.replace(/\\/g, '/').split('/').slice(0, -1);
  return parts.every((part, index) => !part.startsWith('.') || (index < selectedParents.length && parts.slice(0, index + 1).every((value, i) => value === selectedParents[i])));
}

class PreviewResources {
  constructor({ remote } = {}) { this.sessions = new Map(); this.remote = remote; }

  open(project, filePath, kind, mimeType) {
    const previewId = randomBytes(24).toString('hex');
    this.sessions.set(previewId, { project, filePath, kind, mimeType });
    if (this.sessions.size > 32) this.sessions.delete(this.sessions.keys().next().value);
    const encoded = filePath.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
    return { previewId, url: `project-preview://${previewId}/${encoded}` };
  }

  close(previewId) { if (typeof previewId === 'string') this.sessions.delete(previewId); }
  closeProject(projectId) { for (const [id, session] of this.sessions) if (session.project.id === projectId) this.sessions.delete(id); }
  hasUrl(url) { try { const value = new URL(url); return value.protocol === 'project-preview:' && this.sessions.has(value.hostname); } catch { return false; } }

  async resolve(url) {
    const address = new URL(url);
    const session = address.protocol === 'project-preview:' && this.sessions.get(address.hostname);
    if (!session || address.username || address.password || address.port) throw new Error('Preview expired');
    const relativePath = decodeURIComponent(address.pathname).replace(/^\//, '');
    if (!relativePath || !allowsHiddenPath(session, relativePath)) throw new Error('Hidden paths are not preview resources');
    if (!['html', 'markdown'].includes(session.kind) && relativePath !== session.filePath.replace(/\\/g, '/')) throw new Error('Media preview is limited to the selected file');
    const mimeType = session.kind === 'markdown' ? IMAGE_TYPES[path.extname(relativePath).toLowerCase()] : session.kind !== 'html' && session.mimeType ? session.mimeType : WEB_TYPES[path.extname(relativePath).toLowerCase()];
    if (!mimeType) throw new Error('Unsupported preview resource');
    let resolved, size, readChunk;
    if (session.project.kind === 'ssh') {
      const connection = this.remote(session.project);
      const stat = await connection.request('stat', { path: relativePath });
      if (!stat.file || !allowsHiddenPath(session, stat.realPath)) throw new Error('Unsupported remote resource');
      resolved = relativePath; size = stat.size;
      readChunk = async (offset, length) => Buffer.from(await connection.request('read', { path: relativePath, offset, length }), 'base64');
    } else {
      if (session.project.previewRoot && await fs.realpath(session.project.path) !== session.project.previewRoot) throw new Error('Preview folder changed');
      resolved = await resolveProjectPath(session.project, relativePath);
      const relativeReal = path.relative(await fs.realpath(session.project.path), resolved);
      if (!allowsHiddenPath(session, relativeReal.split(path.sep).join('/'))) throw new Error('Hidden link targets are not preview resources');
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) throw new Error('Preview resource is not a supported file');
      size = stat.size;
    }
    return { path: resolved, mimeType, size, readChunk, headers: {
      'Content-Type': mimeType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': PREVIEW_CSP,
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Accept-Ranges': 'bytes',
    } };
  }
}

// Single byte ranges let Chromium seek in large videos without buffering the
// whole file. The same streaming response serves images and HTML resources.
function resourceResponse(resource, request) {
  const headers = { ...resource.headers, 'Content-Length': String(resource.size) };
  let start = 0;
  let end = resource.size - 1;
  let status = 200;
  const range = request.method === 'HEAD' ? null : request.headers.get('range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, resource.size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(end, Number(match[2])) : end;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= resource.size) {
        return new Response(null, { status: 416, headers: { ...headers, 'Content-Length': '0', 'Content-Range': `bytes */${resource.size}` } });
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${resource.size}`;
      headers['Content-Length'] = String(end - start + 1);
    }
  }
  let body = null;
  if (request.method !== 'HEAD' && resource.size > 0) {
    if (resource.readChunk) {
      let offset = start, canceled = false;
      body = new ReadableStream({
        async pull(controller) {
          if (canceled) return;
          if (offset > end) { controller.close(); return; }
          try {
            const bytes = await resource.readChunk(offset, Math.min(256 * 1024, end - offset + 1));
            if (canceled) return;
            if (!bytes.length) throw new Error('远程文件已变化，请刷新预览。');
            offset += bytes.length; controller.enqueue(bytes);
          } catch (error) { if (!canceled) controller.error(error); }
        }, cancel() { canceled = true; },
      });
    } else body = Readable.toWeb(createReadStream(resource.path, { start, end, highWaterMark: 64 * 1024 }));
  }
  return new Response(body, { status, headers });
}

module.exports = { PreviewResources, resourceResponse };
