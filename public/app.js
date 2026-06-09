const state = {
  token: '',
  user: null,
  bookings: [],
  lockers: []
};

const feedback = document.querySelector('#feedback');
const authPanel = document.querySelector('#auth-panel');
const userPanel = document.querySelector('#user-panel');
const operationsPanel = document.querySelector('#operations-panel');
const coordinationPanel = document.querySelector('#coordination-panel');
const loginForm = document.querySelector('#login-form');
const bookingForm = document.querySelector('#booking-form');
const bookingsList = document.querySelector('#bookings');
const lockerSummary = document.querySelector('#locker-summary');
const lockersGrid = document.querySelector('#lockers');
const dashboardOutput = document.querySelector('#dashboard');

function setFeedback(message, isError = false) {
  feedback.textContent = message;
  feedback.style.color = isError ? '#b91c1c' : '#166534';
}

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  if (state.token) {
    headers.Authorization = 'Bearer ' + state.token;
  }

  const response = await fetch(path, {
    ...options,
    headers
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Errore API');
  }
  return data;
}

function renderBookings() {
  bookingsList.innerHTML = '';
  if (!state.bookings.length) {
    bookingsList.innerHTML = '<li>Nessuna prenotazione presente.</li>';
    return;
  }

  for (const booking of state.bookings) {
    const item = document.createElement('li');
    item.className = 'booking-item';
    item.innerHTML = `
      <strong>Locker #${booking.lockerId}</strong>
      <span>Stato: ${booking.status}</span>
      <span>Codice accesso: <code>${booking.accessCode}</code></span>
      <span>Costo: € ${(booking.amountCents / 100).toFixed(2)}</span>
    `;

    const actions = document.createElement('div');
    actions.className = 'booking-actions';

    if (booking.status === 'pending_payment') {
      actions.append(button('Paga', () => payBooking(booking.id)));
    }
    if (booking.status === 'paid') {
      actions.append(button('Apri armadietto', () => openLocker(booking.id, booking.accessCode)));
      actions.append(button('Rilascia', () => releaseLocker(booking.id), true));
    }
    if (booking.status === 'in_use') {
      actions.append(button('Rilascia', () => releaseLocker(booking.id), true));
    }

    item.append(actions);
    bookingsList.append(item);
  }
}

function button(label, onClick, secondary = false) {
  const btn = document.createElement('button');
  btn.textContent = label;
  if (secondary) {
    btn.classList.add('secondary');
  }
  btn.type = 'button';
  btn.addEventListener('click', onClick);
  return btn;
}

function renderLockers() {
  const summary = state.lockers.reduce(
    (acc, locker) => {
      acc[locker.status] = (acc[locker.status] || 0) + 1;
      return acc;
    },
    {}
  );
  lockerSummary.textContent = `Disponibili: ${summary.available || 0}, Prenotati: ${summary.reserved || 0}, Occupati: ${summary.occupied || 0}, Manutenzione: ${summary.maintenance || 0}`;

  lockersGrid.innerHTML = '';
  for (const locker of state.lockers) {
    const card = document.createElement('article');
    card.className = `locker ${locker.status}`;
    card.innerHTML = `#${locker.id}<br /><small>${locker.status}</small>`;
    lockersGrid.append(card);
  }
}

async function refreshData() {
  const [bookingsData, lockersData] = await Promise.all([api('/api/bookings'), api('/api/lockers')]);
  state.bookings = bookingsData.bookings;
  state.lockers = lockersData.lockers;

  renderBookings();
  renderLockers();

  if (state.user.role === 'admin') {
    const dashboard = await api('/api/dashboard');
    dashboardOutput.textContent = JSON.stringify(dashboard.dashboard, null, 2);
  }
}

async function payBooking(bookingId) {
  try {
    await api(`/api/bookings/${bookingId}/pay`, {
      method: 'POST',
      body: JSON.stringify({ paymentMethod: 'card', cardLast4: '4242' })
    });
    setFeedback('Pagamento completato correttamente.');
    await refreshData();
  } catch (error) {
    setFeedback(error.message, true);
  }
}

async function openLocker(bookingId, defaultCode) {
  const code = window.prompt('Inserisci codice di accesso', defaultCode || '');
  if (!code) {
    return;
  }

  try {
    const response = await api(`/api/bookings/${bookingId}/access`, {
      method: 'POST',
      body: JSON.stringify({ accessCode: code })
    });
    setFeedback(response.message || 'Apertura completata.');
    await refreshData();
  } catch (error) {
    setFeedback(error.message, true);
  }
}

async function releaseLocker(bookingId) {
  try {
    const response = await api(`/api/bookings/${bookingId}/release`, {
      method: 'POST',
      body: JSON.stringify({})
    });
    setFeedback(`${response.message} (${response.invoice.notification})`);
    await refreshData();
  } catch (error) {
    setFeedback(error.message, true);
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(loginForm);

  try {
    const response = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: form.get('username'),
        password: form.get('password'),
        otp: form.get('otp')
      })
    });

    state.token = response.token;
    state.user = response.user;

    authPanel.classList.add('hidden');
    userPanel.classList.remove('hidden');
    operationsPanel.classList.remove('hidden');

    if (state.user.role === 'admin') {
      coordinationPanel.classList.remove('hidden');
    }

    setFeedback(`Benvenuto ${state.user.username}. Sessione sicura attiva.`);
    await refreshData();
  } catch (error) {
    setFeedback(error.message, true);
  }
});

bookingForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(bookingForm);

  try {
    await api('/api/bookings', {
      method: 'POST',
      body: JSON.stringify({ durationMinutes: Number(form.get('durationMinutes')) })
    });
    setFeedback('Prenotazione creata con successo. Procedi con il pagamento.');
    await refreshData();
  } catch (error) {
    setFeedback(error.message, true);
  }
});
