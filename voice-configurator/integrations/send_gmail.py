import os
import sys
import json

os.chdir(r"C:\HDP\EmailAgent")
sys.path.insert(0, r"C:\HDP\EmailAgent")
from app.integrations.gmail_client import GmailClient

payload = json.load(sys.stdin)
client = GmailClient(sender_key=payload.get("sender_key") or "outreach-main")
result = client.send_email(
    to_email=payload["to"],
    subject=payload["subject"],
    body_text=payload["body"],
)
print(json.dumps({
    "ok": True,
    "id": result.get("id", ""),
    "threadId": result.get("threadId", ""),
}))
