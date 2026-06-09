const http = require('http');
const { randomUUID, scryptSync, timingSafeEqual } = require('crypto');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

const LOCKER_COUNT = 25;
const SESSION_DURATION_MS = 2 * 60 * 60 * 1000;

const users = [
  createUser('u1', 'mario', 'User#2026!', '173829', 'user'),
  createUser('u2', 'luigi', 'User#2026!', '223344', 'user'),
  createUser('a1', 'admin', 'Admin#2026!', '998811', 'admin')
];

const sessions = new Map();

const state = {
  lockers: Array.from({ length: LOCKER_COUNT }, (_, index) => ({
    id: index + 1,
    status: 'available',
    bookingId: null,
    lastEventAt: null
  })),
  bookings: [],
  invoices: [],
  auditEvents: []
};

function createUser(id, username, password, otp, role) {
  const salt = `salt-${username}`;
  return {
    id,
    username,
    role,
    otp,
    salt,
    passwordHash: scryptSync(password, salt, 32)
  };
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 32);
}

function verifyPassword(input, storedHash, salt) {
  const inputHash = hashPassword(input, salt);
  return timingSafeEqual(inputHash, storedHash);
}

function normalizeUser(user) {
  return { id: user.id, username: user.username, role: user.role };
}

class LockerOrchestrator {
  constructor(appState) {
    this.state = appState;
  }

  listLockers() {
    return this.state.lockers;
  }

  listBookings(user) {
    if (user.role === 'admin') {
      return this.state.bookings;
    }
    return this.state.bookings.filter((booking) => booking.userId === user.id);
  }

  listAuditEvents() {
    return this.state.auditEvents;
  }

  listInvoices(user) {
    if (user.role === 'admin') {
      return this.state.invoices;
    }
    return this.state.invoices.filter((invoice) => invoice.userId === user.id);
  }

  createBooking(user, payload) {
    const requestedMinutes = Number(payload.durationMinutes ?? 120);
    if (!Number.isFinite(requestedMinutes) || requestedMinutes < 30 || requestedMinutes > 1440) {
      throw new ApiError(400, 'Durata non valida. Inserisci un valore tra 30 e 1440 minuti.');
    }

    const availableLocker = this.state.lockers.find((locker) => locker.status === 'available');
    if (!availableLocker) {
      throw new ApiError(409, 'Nessun armadietto disponibile al momento.');
    }

    const booking = {
      id: randomUUID(),
      userId: user.id,
      lockerId: availableLocker.id,
      status: 'pending_payment',
      amountCents: requestedMinutes * 15,
      durationMinutes: requestedMinutes,
      accessCode: randomUUID().slice(0, 8).toUpperCase(),
      createdAt: new Date().toISOString(),
      paidAt: null,
      accessedAt: null,
      releasedAt: null
    };

    availableLocker.status = 'reserved';
    availableLocker.bookingId = booking.id;
    availableLocker.lastEventAt = new Date().toISOString();

    this.state.bookings.push(booking);
    this.logEvent('booking_created', user.id, booking.lockerId, booking.id, {
      requestedMinutes,
      amountCents: booking.amountCents
    });
    return booking;
  }

  payBooking(user, bookingId, payload) {
    const booking = this.requireBooking(bookingId);
    this.assertBookingOwnership(user, booking);

    if (booking.status !== 'pending_payment') {
      throw new ApiError(409, 'Pagamento non consentito per lo stato attuale della prenotazione.');
    }

    const paymentMethod = String(payload.paymentMethod ?? '').trim();
    const cardLast4 = String(payload.cardLast4 ?? '').trim();

    if (!paymentMethod || !cardLast4.match(/^\d{4}$/)) {
      throw new ApiError(400, 'Dati pagamento non validi.');
    }

    booking.status = 'paid';
    booking.paidAt = new Date().toISOString();

    this.logEvent('payment_completed', user.id, booking.lockerId, booking.id, {
      paymentMethod,
      cardLast4
    });
    return booking;
  }

  requestAccess(user, bookingId, payload) {
    const booking = this.requireBooking(bookingId);
    this.assertBookingOwnership(user, booking);

    if (booking.status !== 'paid') {
      throw new ApiError(409, 'Accesso negato: la prenotazione non risulta pagata.');
    }

    const accessCode = String(payload.accessCode ?? '').trim();
    if (accessCode !== booking.accessCode) {
      this.logEvent('access_denied', user.id, booking.lockerId, booking.id, { reason: 'invalid_access_code' });
      throw new ApiError(403, 'Accesso negato: codice di accesso non valido.');
    }

    booking.status = 'in_use';
    booking.accessedAt = new Date().toISOString();

    const locker = this.requireLocker(booking.lockerId);
    locker.status = 'occupied';
    locker.lastEventAt = booking.accessedAt;

    this.logEvent('locker_opened', user.id, booking.lockerId, booking.id, { source: 'user_request' });
    return booking;
  }

  releaseLocker(user, bookingId) {
    const booking = this.requireBooking(bookingId);
    this.assertBookingOwnership(user, booking);

    if (!['in_use', 'paid'].includes(booking.status)) {
      throw new ApiError(409, 'Rilascio non consentito per lo stato attuale.');
    }

    booking.status = 'completed';
    booking.releasedAt = new Date().toISOString();

    const locker = this.requireLocker(booking.lockerId);
    locker.status = 'available';
    locker.bookingId = null;
    locker.lastEventAt = booking.releasedAt;

    const invoice = {
      id: randomUUID(),
      bookingId: booking.id,
      userId: booking.userId,
      lockerId: booking.lockerId,
      amountCents: booking.amountCents,
      issuedAt: booking.releasedAt,
      notification: 'Email inviata con ricevuta fiscale.'
    };

    this.state.invoices.push(invoice);
    this.logEvent('locker_released', user.id, booking.lockerId, booking.id, {
      invoiceId: invoice.id
    });

    return { booking, invoice };
  }

  setLockerMaintenance(user, lockerId, maintenanceMode) {
    if (user.role !== 'admin') {
      throw new ApiError(403, 'Solo l\'amministratore può modificare lo stato manutenzione.');
    }

    const locker = this.requireLocker(lockerId);

    if (locker.bookingId) {
      throw new ApiError(409, 'Impossibile cambiare stato: armadietto assegnato a prenotazione attiva.');
    }

    locker.status = maintenanceMode ? 'maintenance' : 'available';
    locker.lastEventAt = new Date().toISOString();
    this.logEvent('locker_maintenance_updated', user.id, locker.id, null, { maintenanceMode });
    return locker;
  }

  getDashboard() {
    const summary = this.state.lockers.reduce(
      (acc, locker) => {
        acc[locker.status] += 1;
        return acc;
      },
      { available: 0, reserved: 0, occupied: 0, maintenance: 0 }
    );

    const activeBookings = this.state.bookings.filter((booking) =>
      ['pending_payment', 'paid', 'in_use'].includes(booking.status)
    ).length;

    return {
      totalLockers: this.state.lockers.length,
      lockerSummary: summary,
      activeBookings,
      totalAuditEvents: this.state.auditEvents.length,
      totalInvoices: this.state.invoices.length,
      recentEvents: this.state.auditEvents.slice(-8).reverse()
    };
  }

  requireBooking(bookingId) {
    const booking = this.state.bookings.find((item) => item.id === bookingId);
    if (!booking) {
      throw new ApiError(404, 'Prenotazione non trovata.');
    }
    return booking;
  }

  requireLocker(lockerId) {
    const locker = this.state.lockers.find((item) => item.id === Number(lockerId));
    if (!locker) {
      throw new ApiError(404, 'Armadietto non trovato.');
    }
    return locker;
  }

  assertBookingOwnership(user, booking) {
    if (user.role !== 'admin' && booking.userId !== user.id) {
      this.logEvent('authorization_denied', user.id, booking.lockerId, booking.id, {
        reason: 'booking_not_owned'
      });
      throw new ApiError(403, 'Operazione non autorizzata su questa prenotazione.');
    }
  }

  logEvent(type, userId, lockerId, bookingId, metadata = {}) {
    this.state.auditEvents.push({
      id: randomUUID(),
      type,
      userId,
      lockerId,
      bookingId,
      metadata,
      timestamp: new Date().toISOString()
    });
  }
}

class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const orchestrator = new LockerOrchestrator(state);

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new ApiError(413, 'Payload troppo grande.'));
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new ApiError(400, 'JSON non valido.'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function getSessionFromRequest(req) {
  const authorization = req.headers.authorization ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';

  if (!token) {
    throw new ApiError(401, 'Token mancante.');
  }

  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    throw new ApiError(401, 'Sessione non valida o scaduta.');
  }

  const user = users.find((u) => u.id === session.userId);
  if (!user) {
    throw new ApiError(401, 'Utente sessione non valido.');
  }

  return { user, token };
}

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [token, value] of sessions.entries()) {
    if (value.expiresAt < now) {
      sessions.delete(token);
    }
  }
}

function serveStatic(req, res, pathname) {
  const targetPath = pathname === '/' ? '/index.html' : pathname;
  const safePath = path.normalize(targetPath).replace(/^\.\.(?:\/|\\|$)/, '');
  const absolutePath = path.join(__dirname, 'public', safePath);

  if (!absolutePath.startsWith(path.join(__dirname, 'public'))) {
    json(res, 403, { error: 'Percorso non consentito.' });
    return;
  }

  if (!fs.existsSync(absolutePath) || fs.statSync(absolutePath).isDirectory()) {
    json(res, 404, { error: 'Risorsa non trovata.' });
    return;
  }

  const ext = path.extname(absolutePath);
  const contentType =
    ext === '.html'
      ? 'text/html; charset=utf-8'
      : ext === '.css'
        ? 'text/css; charset=utf-8'
        : ext === '.js'
          ? 'application/javascript; charset=utf-8'
          : 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(absolutePath).pipe(res);
}

async function handleApi(req, res, pathname) {
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const body = await parseBody(req);
    const username = String(body.username ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const otp = String(body.otp ?? '').trim();

    const user = users.find((entry) => entry.username === username);
    if (!user || !verifyPassword(password, user.passwordHash, user.salt) || user.otp !== otp) {
      json(res, 401, { error: 'Credenziali o OTP non validi.' });
      return;
    }

    const token = randomUUID();
    sessions.set(token, {
      userId: user.id,
      expiresAt: Date.now() + SESSION_DURATION_MS
    });

    orchestrator.logEvent('login_success', user.id, null, null, {});
    json(res, 200, {
      token,
      expiresInMinutes: Math.floor(SESSION_DURATION_MS / 60000),
      user: normalizeUser(user)
    });
    return;
  }

  const { user } = getSessionFromRequest(req);

  if (req.method === 'GET' && pathname === '/api/lockers') {
    json(res, 200, { lockers: orchestrator.listLockers() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/bookings') {
    json(res, 200, { bookings: orchestrator.listBookings(user) });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/bookings') {
    const body = await parseBody(req);
    const booking = orchestrator.createBooking(user, body);
    json(res, 201, { booking });
    return;
  }

  if (req.method === 'POST' && pathname.match(/^\/api\/bookings\/[^/]+\/pay$/)) {
    const bookingId = pathname.split('/')[3];
    const body = await parseBody(req);
    const booking = orchestrator.payBooking(user, bookingId, body);
    json(res, 200, { booking });
    return;
  }

  if (req.method === 'POST' && pathname.match(/^\/api\/bookings\/[^/]+\/access$/)) {
    const bookingId = pathname.split('/')[3];
    const body = await parseBody(req);
    const booking = orchestrator.requestAccess(user, bookingId, body);
    json(res, 200, { booking, message: 'Accesso autorizzato, armadietto aperto.' });
    return;
  }

  if (req.method === 'POST' && pathname.match(/^\/api\/bookings\/[^/]+\/release$/)) {
    const bookingId = pathname.split('/')[3];
    const result = orchestrator.releaseLocker(user, bookingId);
    json(res, 200, { ...result, message: 'Armadietto rilasciato e ricevuta inviata.' });
    return;
  }

  if (req.method === 'POST' && pathname.match(/^\/api\/lockers\/\d+\/maintenance$/)) {
    const lockerId = pathname.split('/')[3];
    const body = await parseBody(req);
    const locker = orchestrator.setLockerMaintenance(user, lockerId, Boolean(body.maintenanceMode));
    json(res, 200, { locker });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/dashboard') {
    if (user.role !== 'admin') {
      throw new ApiError(403, 'Solo admin può vedere la dashboard operativa.');
    }
    json(res, 200, { dashboard: orchestrator.getDashboard() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/audit') {
    if (user.role !== 'admin') {
      throw new ApiError(403, 'Solo admin può vedere gli audit log.');
    }
    json(res, 200, { events: orchestrator.listAuditEvents() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/invoices') {
    json(res, 200, { invoices: orchestrator.listInvoices(user) });
    return;
  }

  json(res, 404, { error: 'Endpoint API non trovato.' });
}

function createAppServer() {
  return http.createServer(async (req, res) => {
    try {
      cleanExpiredSessions();

      const parsedUrl = new URL(req.url, 'http://localhost');
      const pathname = parsedUrl.pathname;

      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, pathname);
        return;
      }

      serveStatic(req, res, pathname);
    } catch (error) {
      if (error instanceof ApiError) {
        json(res, error.statusCode, { error: error.message });
        return;
      }
      json(res, 500, { error: 'Errore interno del server.' });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 3000);
  createAppServer().listen(port, () => {
    process.stdout.write(`Locker app in ascolto su http://localhost:${port}\n`);
  });
}

module.exports = {
  createAppServer,
  state,
  sessions,
  users,
  ApiError,
  LockerOrchestrator
};
