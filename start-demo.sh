#!/bin/bash
# Start the app on this Mac and share it on a public link (Cloudflare quick tunnel).
# Usage:  ./start-demo.sh        Stop with Ctrl+C (stops the backend too).
# The link changes every time this starts. Look for "https://....trycloudflare.com" below.
set -e
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:$PATH"  # use Homebrew's Node, not nvm's old Node 14

echo "1/3 Building the frontend..."
(cd frontend && npx ng build > /dev/null)

echo "2/3 Starting the backend on http://localhost:8000 ..."
# The secret key is kept in a file so logins stay valid when the demo is restarted.
[ -f backend/.secret_key ] || python3 -c "import secrets; print(secrets.token_urlsafe(48))" > backend/.secret_key
export SECRET_KEY="$(cat backend/.secret_key)"
cd backend
venv/bin/uvicorn app.main:app --port 8000 --log-level warning &
BACKEND_PID=$!
trap 'kill $BACKEND_PID 2>/dev/null' EXIT
until curl -s -o /dev/null http://localhost:8000/login; do sleep 0.5; done

echo "3/3 Opening the public link (keeps the Mac awake while running)..."
caffeinate -dims cloudflared tunnel --url http://localhost:8000
