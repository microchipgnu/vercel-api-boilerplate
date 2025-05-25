import { Hono } from 'hono';

export const runtime = 'nodejs'

const app = new Hono();

// Add logging middleware
app.use('*', async (c, next) => {
    const start = Date.now();
    const method = c.req.method;
    const url = c.req.url;
    const userAgent = c.req.header('user-agent') || 'unknown';
    const contentType = c.req.header('content-type') || 'unknown';

    console.log(`[${new Date().toISOString()}] Incoming ${method} request to ${url}`);
    console.log(`  User-Agent: ${userAgent}`);
    console.log(`  Content-Type: ${contentType}`);

    // Log request headers
    console.log('  Headers:', Object.fromEntries(c.req.raw.headers.entries()));

    await next();

    const duration = Date.now() - start;
    const status = c.res.status;

    console.log(`[${new Date().toISOString()}] ${method} ${url} - ${status} (${duration}ms)`);
});

// Export Hono handlers
export const GET = app.fetch;
export const POST = app.fetch;
export const DELETE = app.fetch;
