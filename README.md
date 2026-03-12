# PayGate

Payment webhook receiver and purchase status service

Part of the [CloudPipe](https://github.com/Jeffrey0117/CloudPipe) ecosystem.

## Quick Start

```bash
npm install
PORT=4019 node server.js
```

## Environment

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 4019) |

## API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/webhook` | Receive payment webhook from Classroo or other payment sources. Creates a purchase record, sends confirmation email and Telegram notification. |
| GET | `/api/purchases/check` | Check if a user has an active purchase for a product. Public endpoint, no auth required. |
| GET | `/api/purchases/{email}` | List all purchases for a given email address |
| POST | `/api/activate` | Manually activate a purchase (admin use). Creates a purchase record without payment webhook. |

## License

MIT
