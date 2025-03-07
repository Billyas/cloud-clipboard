import fs from 'node:fs';
import KoaRouter from '@koa/router';
import { koaBody } from 'koa-body';
import koaWebsocket from 'koa-websocket';
import sharp from 'sharp';

import config from './config.js';
import messageQueue from './message.js';
import {
    UploadedFile,
    uploadFileMap,
} from './uploaded-file.js';
import {
    writeJSON,
    wsBoardcast,
} from './util.js';

const router = new KoaRouter;

router.get('/server', async ctx => {
    ctx.body = {
        'server': `ws${(config.server.forceWss || ctx.request.protocol === 'https') ? 's' : ''}://${ctx.request.host}/push`,
        'auth': !!config.server.auth,
    };
});

router.post(
    '/text',
    koaBody({
        enableTypes: ['text'],
    }),
    async ctx => {
        /** @type {String} */
        let body = ctx.request.body;
        if (body.length > config.text.limit) {
            writeJSON(ctx, 400, {}, `文本长度不能超过 ${config.text.limit} 字`);
            return;
        }
        body = body
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
        const message = {
            event: 'receive',
            data: {
                id: messageQueue.counter,
                type: 'text',
                content: body,
            },
        };
        messageQueue.enqueue(message);
        /** @type {koaWebsocket.App<Koa.DefaultState, Koa.DefaultContext>} */
        const app = ctx.app;
        wsBoardcast(app.ws, JSON.stringify(message));
        writeJSON(ctx);
    }
);

router.delete('/revoke/:id(\\d+)', async ctx => {
    const id = parseInt(ctx.params.id);
    if (!messageQueue.queue.some(e => e.data.id === id)) {
        return writeJSON(ctx, 400, {}, '不存在的消息 ID');
    }
    messageQueue.queue.splice(messageQueue.queue.findIndex(e => e.data.id === id), 1);
    /** @type {koaWebsocket.App<Koa.DefaultState, Koa.DefaultContext>} */
    const app = ctx.app;
    wsBoardcast(app.ws, JSON.stringify({
        event: 'revoke',
        data: {
            id,
        },
    }));
    writeJSON(ctx);
});

router.post(
    '/upload',
    koaBody({
        enableTypes: ['text'],
    }),
    async ctx => {
        /** @type {String} */
        const filename = ctx.request.body;
        const file = new UploadedFile(filename);
        uploadFileMap.set(file.uuid, file);
        writeJSON(ctx, 200, {
            uuid: file.uuid,
        });
    }
);

router.post('/upload/chunk/:uuid([0-9a-f]{32})', async ctx => {
    try {
        const file = uploadFileMap.get(ctx.params.uuid);
        if (!file) {
            throw new Error('无效的 UUID');
        }
        const data = await new Promise((resolve, reject) => {
            let data = Buffer.alloc(0);
            ctx.req.on('data', chunk => data = Buffer.concat([data, chunk]));
            ctx.req.on('error', error => reject(error));
            ctx.req.on('end', () => resolve(data));
        });
        await file.write(data);
        writeJSON(ctx);
    } catch (error) {
        writeJSON(ctx, 400, error.message || error);
    }
});

router.post('/upload/finish/:uuid([0-9a-f]{32})', async ctx => {
    try {
        const file = uploadFileMap.get(ctx.params.uuid);
        if (!file) {
            throw new Error('无效的 UUID');
        }
        await file.finish();

        const message = {
            event: 'receive',
            data: {
                id: messageQueue.counter,
                type: 'file',
                name: file.name,
                size: file.size,
                cache: file.uuid,
                expire: file.expireTime,
            },
        };
        try {
            if (file.size > 33554432) throw new Error;
            const img = sharp(file.path);
            const { width, height } = await img.metadata();
            if (Math.min(width, height) > 64) {
                const ratio = 64 / Math.min(width, height);
                img.resize(Math.round(width * ratio), Math.round(height * ratio), {
                    kernel: sharp.kernel.lanczos3,
                    withoutEnlargement: true,
                });
            }
            message.data.thumbnail = 'data:image/jpeg;base64,' + (await img.toFormat('jpg', {
                quality: 70,
                optimizeScans: true,
            }).toBuffer()).toString('base64');
        } catch {}
        messageQueue.enqueue(message);

        /** @type {koaWebsocket.App<Koa.DefaultState, Koa.DefaultContext>} */
        const app = ctx.app;
        wsBoardcast(app.ws, JSON.stringify(message));
        writeJSON(ctx);
    } catch (error) {
        writeJSON(ctx, 400, error.message || error);
    }
});

router.get('/file/:uuid([0-9a-f]{32})', async ctx => {
    const file = uploadFileMap.get(ctx.params.uuid);
    if (!file || Date.now() / 1000 > file.expireTime || !fs.existsSync(file.path)) {
        return ctx.status = 404;
    }
    ctx.attachment(file.name, {type: 'inline'});
    const fileSize = (await fs.promises.stat(file.path)).size;
    // https://github.com/xtx1130/koa-partial-content/blob/master/index.js
    if (file.name.match(/\.(mp3|mp4|flv|webm|ogv|mpg|mpg|wav|ogg|opus|m4a)$/gi)) {
        try {
            const m = /^bytes=(\d+)-(\d*)$/.exec(ctx.request.header.range || 'bytes=0-');
            if (!m) throw new Error;
            const rangeStart = parseInt(m[1]);
            const rangeEnd = parseInt(m[2] || (fileSize - 1));
            ctx.set('Accept-Range', 'bytes');
            if (rangeEnd > fileSize - 1 || rangeEnd > fileSize - 1) {
                throw new Error;
            } else {
                ctx.status = 206;
                ctx.set('Content-Range', `bytes ${rangeStart}-${rangeEnd}/${fileSize}`);
                await new Promise(resolve => {
                    const rs = fs.createReadStream(file.path, {
                        start: rangeStart,
                        end: rangeEnd,
                    });
                    rs.on('open', () => rs.pipe(ctx.res));
                    rs.on('end', resolve);
                    rs.on('error', () => resolve(ctx.throw(500)));
                });
            }
        } catch (err) {
            ctx.throw(416);
            ctx.set('Content-Range', `bytes */${fileSize}`);
        }
    } else {
        ctx.body = fs.createReadStream(file.path);
    }
});

router.delete('/file/:uuid([0-9a-f]{32})', async ctx => {
    const file = uploadFileMap.get(ctx.params.uuid);
    if (!file) {
        return writeJSON(ctx, 404);
    }
    file.remove();
    writeJSON(ctx);
});

export default router;