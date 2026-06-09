const test = require('node:test');
const assert = require('node:assert/strict');
const { createAppServer, state, sessions } = require('../server');

function resetState() {
  state.bookings.length = 0;
  state.invoices.length = 0;
  state.auditEvents.length = 0;
  state.lockers.forEach((locker) => {
    locker.status = 'available';
    locker.bookingId = null;
    locker.lastEventAt = null;
  });
  sessions.clear();
}

async function makeRequest(server, method, path, body, token) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const payload = await response.json();
  return { status: response.status, payload };
}

async function login(server, username, password, otp) {
  const res = await makeRequest(server, 'POST', '/api/auth/login', { username, password, otp });
  assert.equal(res.status, 200);
  return res.payload.token;
}

test.beforeEach(() => {
  resetState();
});

test('runs full booking lifecycle and releases locker with invoice', async () => {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const token = await login(server, 'mario', 'User#2026!', '173829');

    const bookingRes = await makeRequest(server, 'POST', '/api/bookings', { durationMinutes: 120 }, token);
    assert.equal(bookingRes.status, 201);
    assert.equal(bookingRes.payload.booking.status, 'pending_payment');

    const bookingId = bookingRes.payload.booking.id;
    const accessCode = bookingRes.payload.booking.accessCode;

    const paymentRes = await makeRequest(server, 'POST', `/api/bookings/${bookingId}/pay`, { paymentMethod: 'card', cardLast4: '1111' }, token);
    assert.equal(paymentRes.status, 200);
    assert.equal(paymentRes.payload.booking.status, 'paid');

    const accessRes = await makeRequest(server, 'POST', `/api/bookings/${bookingId}/access`, { accessCode }, token);
    assert.equal(accessRes.status, 200);
    assert.equal(accessRes.payload.booking.status, 'in_use');

    const releaseRes = await makeRequest(server, 'POST', `/api/bookings/${bookingId}/release`, {}, token);
    assert.equal(releaseRes.status, 200);
    assert.equal(releaseRes.payload.booking.status, 'completed');
    assert.equal(state.invoices.length, 1);
    assert.equal(state.lockers.find((l) => l.id === releaseRes.payload.booking.lockerId).status, 'available');
  } finally {
    server.close();
  }
});

test('prevents opening locker with invalid code and logs denial', async () => {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const token = await login(server, 'mario', 'User#2026!', '173829');
    const bookingRes = await makeRequest(server, 'POST', '/api/bookings', { durationMinutes: 60 }, token);
    const bookingId = bookingRes.payload.booking.id;

    await makeRequest(server, 'POST', `/api/bookings/${bookingId}/pay`, { paymentMethod: 'card', cardLast4: '4444' }, token);

    const denied = await makeRequest(server, 'POST', `/api/bookings/${bookingId}/access`, { accessCode: 'WRONG123' }, token);
    assert.equal(denied.status, 403);
    assert.match(denied.payload.error, /Accesso negato/);

    assert.equal(state.auditEvents.some((event) => event.type === 'access_denied'), true);
  } finally {
    server.close();
  }
});

test('blocks unauthorized access to another user booking', async () => {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const marioToken = await login(server, 'mario', 'User#2026!', '173829');
    const adminToken = await login(server, 'admin', 'Admin#2026!', '998811');

    const bookingRes = await makeRequest(server, 'POST', '/api/bookings', { durationMinutes: 90 }, marioToken);
    const bookingId = bookingRes.payload.booking.id;

    const adminView = await makeRequest(server, 'GET', '/api/bookings', null, adminToken);
    assert.equal(adminView.status, 200);
    assert.equal(adminView.payload.bookings.length, 1);

    const luigiToken = await login(server, 'luigi', 'User#2026!', '223344');
    const forbiddenRequest = await makeRequest(server, 'POST', `/api/bookings/${bookingId}/access`, { accessCode: 'ABCDE123' }, luigiToken);
    assert.equal(forbiddenRequest.status, 403);
  } finally {
    server.close();
  }
});

test('restricts dashboard endpoint to admin role', async () => {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const userToken = await login(server, 'mario', 'User#2026!', '173829');
    const adminToken = await login(server, 'admin', 'Admin#2026!', '998811');

    const forbiddenRes = await makeRequest(server, 'GET', '/api/dashboard', null, userToken);
    assert.equal(forbiddenRes.status, 403);

    const adminRes = await makeRequest(server, 'GET', '/api/dashboard', null, adminToken);
    assert.equal(adminRes.status, 200);
    assert.equal(adminRes.payload.dashboard.totalLockers, 25);
  } finally {
    server.close();
  }
});
