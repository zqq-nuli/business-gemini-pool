# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Business Gemini Pool is a Flask-based proxy service for Google Gemini Enterprise API that provides:
- Multi-account round-robin load balancing
- OpenAI-compatible chat completions API
- Image generation and caching support
- Web-based admin console
- Automatic JWT token management

## Development Commands

### Install Dependencies
```bash
pip install -r requirements.txt
```

### Run Service
```bash
python gemini.py
```
The service starts on `http://0.0.0.0:8000`

### Test API
```bash
# Chat completion
curl -X POST http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gemini-enterprise", "messages": [{"role": "user", "content": "Hello"}]}'

# List models
curl http://127.0.0.1:8000/v1/models

# Health check
curl http://127.0.0.1:8000/health
```

## Architecture

### Configuration Management
- Configuration is stored in `business_gemini_session.json`
- On first run, if config doesn't exist, it's copied from `business_gemini_session.json.example`
- The `AccountManager` class (gemini.py:49-116) manages all account state and round-robin logic

### Account Round-Robin System
The system uses a stateful round-robin scheduler:
- `account_states` (gemini.py:56) tracks JWT, session, and availability per account
- `get_next_account()` (gemini.py:98-109) rotates through available accounts
- `mark_account_unavailable()` (gemini.py:82-91) removes failing accounts from rotation
- JWT tokens are cached for 240 seconds (gemini.py:244)

### JWT Authentication Flow
1. Get XSRF token from `/auth/getoxsrf` endpoint (gemini.py:190-222)
2. Decode XSRF token and create JWT using HMAC-SHA256 (gemini.py:161-187)
3. JWT expires after 300 seconds but is refreshed at 240 seconds (gemini.py:244)
4. Uses custom base64 encoding (`kq_encode`) to match Google's format (gemini.py:140-150)

### Session Management
- Each account maintains a persistent chat session (gemini.py:256-284)
- Sessions are created once per account and reused (gemini.py:286-295)
- Session ID is a 12-character hex string (gemini.py:258)

### Image Processing Pipeline
Images flow through the system in multiple formats:
1. **Input**: OpenAI format (base64 or URL) → extracted by `extract_images_from_openai_content()` (gemini.py:366-414)
2. **Request**: Converted to Gemini `inlineData` format (gemini.py:519-538)
3. **Response**: Multiple formats are parsed:
   - `generatedImages` with `bytesBase64Encoded` (gemini.py:678-700)
   - `inlineData` in content (gemini.py:703-723)
   - `file` references requiring JWT download (gemini.py:619-668)
   - Attachments with base64 data (gemini.py:726-749)
4. **Storage**: Cached in `image/` directory with automatic cleanup after 1 hour (gemini.py:319-363)
5. **Output**: Served via `/image/<filename>` endpoint (gemini.py:942-964)

### API Compatibility
The service translates between OpenAI and Gemini formats:
- OpenAI `/v1/chat/completions` → Gemini `widgetStreamAssist` (gemini.py:786-897)
- OpenAI message format → Gemini `query.parts` structure (gemini.py:515-558)
- Gemini responses → OpenAI completion format (gemini.py:835-892)

## Key Implementation Details

### Configuration File Structure
```json
{
  "proxy": "http://127.0.0.1:7890",
  "image_base_url": "http://127.0.0.1:8000/",
  "accounts": [
    {
      "team_id": "...",
      "secure_c_ses": "...",
      "host_c_oses": "...",
      "csesidx": "...",
      "user_agent": "...",
      "available": true
    }
  ],
  "models": [...]
}
```

### Critical Cookie Parameters
- `secure_c_ses`: Session cookie from `__Secure-C_SES`
- `host_c_oses`: Host cookie from `__Host-C_OSES`
- `csesidx`: Session index used in JWT subject
- These are sent in the `getoxsrf` request to obtain JWT keys (gemini.py:199-208)

### Error Handling Strategy
- JWT failures mark account unavailable (gemini.py:249-252)
- Chat API retries all accounts before failing (gemini.py:813-833)
- Session creation errors don't retry, they propagate (gemini.py:277-280)
- Proxy failures are silent but logged in status checks (gemini.py:122-132)

### Admin API Routes
Management endpoints (gemini.py:994-1276):
- `/api/accounts` - CRUD for account management
- `/api/models` - CRUD for model configuration
- `/api/config` - Import/export full configuration
- `/api/proxy/test` - Test proxy connectivity
- `/api/accounts/<id>/test` - Test individual account JWT

### Frontend Integration
- `index.html` - Admin console for account/model management
- `chat_history.html` - Chat history viewer
- Both served as static files (gemini.py:996-1004)

## Security Considerations

- Configuration file contains sensitive credentials (`secure_c_ses`, `host_c_oses`)
- SSL verification is disabled (gemini.py:26-27, verify=False throughout)
- No authentication on admin endpoints
- Image path traversal protection (gemini.py:946-947)
- CORS is enabled for all origins (gemini.py:46)
