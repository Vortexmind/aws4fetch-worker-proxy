# AWS S3 Proxy Worker with aws4fetch

> **Disclaimer:** This code is provided as a sample/template for educational and reference purposes only. It is provided "as-is" without warranty of any kind. See the [LICENSE](LICENSE) file for details. You are responsible for reviewing, testing, and adapting this code for your own use case before deploying to production.

A Cloudflare Worker that proxies requests to a **private** AWS S3 bucket hosting a static web application. The bucket never needs to be made public; the Worker signs every request using AWS Signature V4 via [aws4fetch](https://github.com/mhart/aws4fetch).

## Architecture

```
                                        ┌─────────────────────┐
                                        │   AWS S3 Bucket     │
                                        │   (Private)         │
                                        │                     │
                                        │  - Block public     │
┌──────────┐    ┌─────────────────┐     │    access: ON       │
│  Client  │--->│ Cloudflare Edge │---->│                     │
│ (Browser)│<---│                 │<----│ IAM policy:         │
└──────────┘    │  - TLS          │     │    GetObject only   │
                │  - Caching      │     │                     │
                │  - Worker       │     └─────────────────────┘
                │    (signs req)  │
                └─────────────────┘
```

**How it works:**

1. Client requests `https://your-worker.workers.dev/assets/app.js`
2. Cloudflare edge receives the request and invokes the Worker
3. Worker checks edge cache; if miss, signs request with AWS credentials
4. Worker fetches from S3 using the signed request
5. Worker sanitizes response headers and caches at the edge
6. Client receives the file with Cloudflare's CDN benefits

## Prerequisites

- **Cloudflare account** with Workers enabled
- **AWS account** with an S3 bucket containing your static site
- **AWS IAM credentials** scoped to the specific bucket (see IAM Policy below)
- **Node.js** 18+ and npm

## Quick Start

### 1. Clone and install dependencies

```bash
cd output/aws4fetch-worker-proxy
npm install
```

### 2. Configure the bucket and region

Edit `wrangler.jsonc` and set your bucket name and region:

```jsonc
{
  "vars": {
    "S3_BUCKET": "your-actual-bucket-name",
    "S3_REGION": "eu-west-1",  // or your region
    "SPA_MODE": "true",
    "CACHE_MAX_AGE": "3600"
  }
}
```

### 3. Set up local development secrets

Copy the example file and add your AWS credentials:

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars`:

```
AWS_ACCESS_KEY_ID=AKIA...your-key...
AWS_SECRET_ACCESS_KEY=...your-secret...
```

**Never commit `.dev.vars` to version control.**

### 4. Run locally

```bash
npm run dev
```

Open `http://localhost:8787` in your browser.

### 5. Deploy to Cloudflare

First, add your secrets to Cloudflare:

```bash
npx wrangler secret put AWS_ACCESS_KEY_ID
# Paste your access key when prompted

npx wrangler secret put AWS_SECRET_ACCESS_KEY
# Paste your secret key when prompted
```

Then deploy:

```bash
npm run deploy
```

## AWS IAM Policy

Create a dedicated IAM user (or role) with the minimum required permissions. **Never use broad `s3:*` permissions.**

### Minimal policy for read-only access

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowGetObject",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject"
      ],
      "Resource": "arn:aws:s3:::your-bucket-name/*"
    },
    {
      "Sid": "AllowListBucket",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket"
      ],
      "Resource": "arn:aws:s3:::your-bucket-name"
    }
  ]
}
```

Replace `your-bucket-name` with your actual bucket name.

### Creating the IAM user

1. Go to AWS IAM Console > Users > Create User
2. Name it something like `cloudflare-s3-proxy-readonly`
3. Attach the policy above (create it as an inline policy or managed policy)
4. Create an access key under Security Credentials
5. Save the Access Key ID and Secret Access Key securely

## Configuration Options

All configuration is in `wrangler.jsonc`:

| Variable | Description | Default |
|----------|-------------|---------|
| `S3_BUCKET` | S3 bucket name (not the full URL) | `my-private-bucket` |
| `S3_REGION` | AWS region (e.g., `us-east-1`, `eu-west-1`) | `us-east-1` |
| `SPA_MODE` | Serve `index.html` for 404s (for React/Vue/Angular apps) | `true` |
| `CACHE_MAX_AGE` | Edge cache duration in seconds | `3600` |

### SPA Mode

When `SPA_MODE` is `true`:

- Requests to `/some/route` that return 404 from S3 will serve `/index.html` instead
- This enables client-side routing in single-page applications
- Direct file requests (e.g., `/assets/app.js`) work normally

Set `SPA_MODE` to `false` for traditional static sites where every URL maps to an actual file.

## Security Considerations

### What this Worker does for security

1. **Path traversal prevention**: Blocks `..` in paths
2. **Method restriction**: Only GET and HEAD allowed (405 for others)
3. **Header sanitization**: Strips all `x-amz-*` headers from responses
4. **Error masking**: Does not leak S3 error details to clients
5. **Security headers**: Adds `X-Content-Type-Options: nosniff`

### What you should add for production

1. **Rate limiting**: Configure Cloudflare Rate Limiting rules or use the Rate Limiting API in the Worker

2. **Access control** (if the site should not be public):
   - Add Cloudflare Access (Zero Trust) in front of the Worker
   - Or implement JWT/token validation in the Worker
   - Or add IP allowlisting via Cloudflare WAF

3. **Custom domain**: Deploy to a custom domain instead of `*.workers.dev`:
   ```jsonc
   {
     "routes": [
       { "pattern": "app.example.com/*", "zone_name": "example.com" }
     ]
   }
   ```

4. **Monitoring**: Enable Cloudflare Workers Analytics and set up alerts

## Secrets Management

### For individual Workers (current approach)

Secrets are set per-Worker using `wrangler secret put`. This is simple but requires setting secrets for each Worker separately.

### For teams: Secrets Store (recommended)

For multiple Workers or team environments, use [Cloudflare Secrets Store](https://developers.cloudflare.com/secrets-store/):

1. Create a secrets store and add your AWS credentials there
2. Bind the secrets to your Worker in `wrangler.jsonc`:

```jsonc
{
  "secrets_store_secrets": [
    {
      "binding": "AWS_ACCESS_KEY_ID",
      "store_id": "your-store-id",
      "secret_name": "aws-access-key-id"
    },
    {
      "binding": "AWS_SECRET_ACCESS_KEY",
      "store_id": "your-store-id",
      "secret_name": "aws-secret-access-key"
    }
  ]
}
```

This allows centralized credential management and rotation without redeploying Workers.

## Caching Strategy

The Worker uses two layers of caching:

1. **Cloudflare Edge Cache**: Responses are cached at Cloudflare's edge using the Cache API. The `CACHE_MAX_AGE` setting controls how long content stays cached.

2. **Browser Cache**: The `Cache-Control` header tells browsers to cache responses locally.

### Purging the cache

To purge cached content after deploying new files to S3:

```bash
# Purge everything (use sparingly)
curl -X POST "https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache" \
  -H "Authorization: Bearer {api_token}" \
  -H "Content-Type: application/json" \
  --data '{"purge_everything":true}'

# Purge specific URLs
curl -X POST "https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache" \
  -H "Authorization: Bearer {api_token}" \
  -H "Content-Type: application/json" \
  --data '{"files":["https://app.example.com/index.html"]}'
```

Or use the Cloudflare dashboard: Caching > Configuration > Purge Cache.

## Testing

### Local testing with wrangler dev

```bash
npm run dev

# In another terminal:
curl -i http://localhost:8787/
curl -i http://localhost:8787/index.html
curl -i http://localhost:8787/assets/app.js
curl -i http://localhost:8787/nonexistent  # Should return index.html in SPA mode
curl -X POST http://localhost:8787/  # Should return 405
```

### Testing deployed Worker

```bash
curl -i https://s3-proxy.your-subdomain.workers.dev/
curl -I https://s3-proxy.your-subdomain.workers.dev/  # HEAD request
```

### Viewing logs

```bash
npm run tail
# or
npx wrangler tail
```

## Troubleshooting

### "SignatureDoesNotMatch" error

- Verify `S3_REGION` matches the actual bucket region
- Check that credentials are correct (no extra whitespace)
- Ensure the bucket name is exact (case-sensitive)

### "Access Denied" from S3

- Verify the IAM policy allows `s3:GetObject` on the correct bucket ARN
- Check that the IAM user/role has the policy attached
- Ensure the bucket does not have a bucket policy that denies access

### 404 for all requests

- Verify the bucket contains the expected files
- Check that file paths in S3 match the requested URLs
- Try disabling SPA mode to see actual 404s vs fallback

### Stale content after S3 update

- Purge the Cloudflare cache (see Caching Strategy above)
- Reduce `CACHE_MAX_AGE` during development

## Alternatives

Consider these alternatives:

### 1. Cloudflare R2 with Bindings (Recommended)

If you can migrate data to Cloudflare R2:

- **Zero-latency access** from Workers (same network)
- **No credentials to manage** (bindings are automatic)
- **S3-compatible API** for easy migration
- **No egress fees** for data read by Workers

```jsonc
// wrangler.jsonc with R2 binding
{
  "r2_buckets": [
    { "binding": "BUCKET", "bucket_name": "my-bucket" }
  ]
}
```

```typescript
// Worker code with R2
const object = await env.BUCKET.get(key);
return new Response(object.body);
```

### 2. Public S3 Bucket Locked to Cloudflare IPs

If authenticated signing is not required:

- Make the bucket publicly readable
- Add a bucket policy that only allows Cloudflare IP ranges
- Use Cloudflare DNS + CDN (no Worker needed)
- Simpler, but the bucket is technically "public"

### 3. Workers VPC with Cloudflare Tunnel

For S3 buckets behind a VPC endpoint (not internet-accessible):

- Deploy `cloudflared` in your VPC
- Create a Workers VPC Service
- Worker accesses S3 through the tunnel
- **No IAM credentials in the Worker**

See: [Workers VPC Private S3 Bucket](https://developers.cloudflare.com/workers-vpc/examples/private-s3-bucket/)

### 4. Cloudflare Zero Trust Egress Policies (Enterprise)

For enterprise customers:

- Use dedicated egress IPs
- Whitelist those IPs in S3 bucket policy
- Route traffic through Cloudflare Gateway

See: [Protect S3 with Zero Trust](https://developers.cloudflare.com/cloudflare-one/tutorials/s3-buckets/)

### 5. Presigned URL Redirect

If files are large and you want to avoid streaming through the Worker:

- Worker generates a short-lived presigned URL (e.g., 60 seconds)
- Worker returns a 302 redirect to the presigned URL
- Client downloads directly from S3
- Reduces Worker CPU time and avoids body size limits

```typescript
// Generate presigned URL and redirect
const signedUrl = await generatePresignedUrl(key, 60);
return Response.redirect(signedUrl, 302);
```

## Resources

- [aws4fetch on npm](https://www.npmjs.com/package/aws4fetch)
- [Cloudflare Workers documentation](https://developers.cloudflare.com/workers/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Secrets Store](https://developers.cloudflare.com/secrets-store/)
- [AWS S3 REST API](https://docs.aws.amazon.com/AmazonS3/latest/API/Welcome.html)
- [AWS Signature Version 4](https://docs.aws.amazon.com/general/latest/gr/signature-version-4.html)

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for the full text.

**This code is provided as a sample/template for educational purposes.** It is offered "as-is" without any warranty, express or implied. The authors and contributors accept no liability for any damages, security issues, or costs arising from the use of this code. You are solely responsible for:

- Reviewing and understanding the code before use
- Testing thoroughly in your own environment
- Adapting the code to meet your specific security and compliance requirements
- Managing your own AWS credentials and Cloudflare configuration securely
- Any costs incurred from AWS, Cloudflare, or other services
