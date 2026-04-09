/**
 * Cloudflare Worker proxy for private AWS S3 buckets.
 *
 * Signs requests using AWS Signature V4 via aws4fetch, allowing secure access
 * to S3 without making the bucket public. Includes SPA fallback routing.
 */

import { AwsClient } from "aws4fetch";

/**
 * Environment bindings for the Worker.
 * Secrets (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) are set via `wrangler secret put`.
 * Vars (S3_BUCKET, S3_REGION, etc.) are defined in wrangler.jsonc.
 */
interface Env {
  // Secrets (encrypted, set via wrangler secret put)
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;

  // Configuration vars (from wrangler.jsonc)
  S3_BUCKET: string;
  S3_REGION: string;
  SPA_MODE: string;
  CACHE_MAX_AGE: string;
}

/**
 * Headers that are safe to forward from S3 to the client.
 * All x-amz-* headers are stripped for security.
 */
const ALLOWED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-encoding",
  "etag",
  "last-modified",
  "accept-ranges",
];

/**
 * Validate and sanitize the requested object key.
 * Prevents path traversal and other injection attacks.
 */
function validateKey(key: string): { valid: boolean; sanitized: string; error?: string } {
  // Decode URI components
  let decoded: string;
  try {
    decoded = decodeURIComponent(key);
  } catch {
    return { valid: false, sanitized: "", error: "Invalid URL encoding" };
  }

  // Block path traversal attempts
  if (decoded.includes("..")) {
    return { valid: false, sanitized: "", error: "Path traversal not allowed" };
  }

  // Remove leading slashes (S3 keys don't start with /)
  const sanitized = decoded.replace(/^\/+/, "");

  // Block empty keys (will be handled as index.html request)
  if (sanitized === "") {
    return { valid: true, sanitized: "index.html" };
  }

  // If the path ends with /, treat it as a directory and append index.html
  if (sanitized.endsWith("/")) {
    return { valid: true, sanitized: sanitized + "index.html" };
  }

  return { valid: true, sanitized };
}

/**
 * Build the S3 URL for a given key.
 */
function buildS3Url(bucket: string, region: string, key: string): string {
  // Use virtual-hosted style URL (recommended by AWS)
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

/**
 * Create a sanitized response with only allowed headers.
 */
function createSanitizedResponse(
  s3Response: Response,
  cacheMaxAge: number
): Response {
  const headers = new Headers();

  // Copy only allowed headers from S3 response
  for (const headerName of ALLOWED_RESPONSE_HEADERS) {
    const value = s3Response.headers.get(headerName);
    if (value) {
      headers.set(headerName, value);
    }
  }

  // Set caching headers
  headers.set("Cache-Control", `public, max-age=${cacheMaxAge}`);

  // Add security headers
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(s3Response.body, {
    status: s3Response.status,
    statusText: s3Response.statusText,
    headers,
  });
}

/**
 * Fetch an object from S3 with signed request.
 */
async function fetchFromS3(
  client: AwsClient,
  bucket: string,
  region: string,
  key: string,
  method: string
): Promise<Response> {
  const url = buildS3Url(bucket, region, key);

  const signedRequest = await client.sign(url, {
    method,
    // AWS requires specific headers for signature
    headers: {
      // S3 needs the host header (aws4fetch handles this)
    },
  });

  return fetch(signedRequest);
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // Only allow GET and HEAD requests
    if (method !== "GET" && method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    // Validate and sanitize the requested key
    const keyResult = validateKey(url.pathname);
    if (!keyResult.valid) {
      return new Response(keyResult.error || "Bad request", { status: 400 });
    }
    const key = keyResult.sanitized;

    // Parse configuration
    const cacheMaxAge = parseInt(env.CACHE_MAX_AGE, 10) || 3600;
    const spaMode = env.SPA_MODE === "true";

    // Check edge cache first
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cachedResponse = await cache.match(cacheKey);

    if (cachedResponse) {
      // For HEAD requests, return cached response without body
      if (method === "HEAD") {
        return new Response(null, {
          status: cachedResponse.status,
          headers: cachedResponse.headers,
        });
      }
      return cachedResponse;
    }

    // Create AWS client for signing requests
    const awsClient = new AwsClient({
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      service: "s3",
      region: env.S3_REGION,
    });

    // Fetch from S3
    let s3Response = await fetchFromS3(
      awsClient,
      env.S3_BUCKET,
      env.S3_REGION,
      key,
      "GET" // Always GET from S3, even for HEAD requests (we need the body to cache)
    );

    // Handle 404 with SPA fallback
    if (s3Response.status === 404 && spaMode && key !== "index.html") {
      // Try fetching index.html for SPA routing
      s3Response = await fetchFromS3(
        awsClient,
        env.S3_BUCKET,
        env.S3_REGION,
        "index.html",
        "GET"
      );

      // If index.html also doesn't exist, return 404
      if (s3Response.status === 404) {
        return new Response("Not found", { status: 404 });
      }
    } else if (!s3Response.ok) {
      // Handle other S3 errors
      if (s3Response.status === 403) {
        // Don't leak S3 access denied details
        return new Response("Forbidden", { status: 403 });
      }
      if (s3Response.status === 404) {
        return new Response("Not found", { status: 404 });
      }
      // Generic error for other cases
      console.error(`S3 error: ${s3Response.status} ${s3Response.statusText}`);
      return new Response("Upstream error", { status: 502 });
    }

    // Create sanitized response
    const response = createSanitizedResponse(s3Response, cacheMaxAge);

    // Store in edge cache (don't await, use waitUntil)
    ctx.waitUntil(cache.put(cacheKey, response.clone()));

    // For HEAD requests, return response without body
    if (method === "HEAD") {
      return new Response(null, {
        status: response.status,
        headers: response.headers,
      });
    }

    return response;
  },
} satisfies ExportedHandler<Env>;
