import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import bridge from '@vkontakte/vk-bridge';
import { io } from 'socket.io-client';
import { SPLASH_IMAGE } from './assets.js';
import './styles.css';

const BarTableScene = lazy(() => import('./BarTableScene.jsx'));

const APP_ID = 54584981;
const ADMIN_ID = 1057236881;
const STORAGE_KEY = 'bar-znakomstv-demo-state-v1';
const LAUNCH_PARAMS = window.location.search.slice(1);

const demoUserId = Number(new URLSearchParams(window.location.search).get('vk_user_id')) || 100000001;
const fallbackUser = {
  id: demoUserId,
  first_name: demoUserId === ADMIN_ID ? 'BlackJack' : 'Гость',
  last_name: demoUserId === ADMIN_ID ? 'Torro' : '',
  photo_100: SPLASH_IMAGE
};

const initialMessages = [
  {
    id: 'welcome-1',
    userId: 0,
    name: 'БАР Знакомств!',
    avatar: SPLASH_IMAGE,
    text: 'Добро пожаловать. Тут будет общий чат бара: реальные имена из VK, время и дата каждого сообщения.',
    createdAt: new Date().toISOString(),
    system: true
  }
];

const shopProducts = [
  {
    title: 'BJT Монеты',
    subtitle: 'Золотая монета в стиле биткойна',
    icon: '₿',
    value: '10 BJT = 1 голос VK = 7 ₽'
  },
  {
    title: 'Звёзды',
    subtitle: 'Внутренняя валюта подарков',
    icon: '★',
    value: '10 BJT = 20 звёзд'
  },
  {
    title: 'Подарки тестерам',
    subtitle: 'Админ может начислять BJT/звёзды',
    icon: '🎁',
    value: 'Доступно администратору'
  }
];

function App() {
  const [screen, setScreen] = useState('splash');
  const [activeSection, setActiveSection] = useState('home');
  const [user, setUser] = useState(fallbackUser);
  const [vkReady, setVkReady] = useState(false);
  const [socket, setSocket] = useState(null);
  const [messages, setMessages] = useState(initialMessages);
  const [balance, setBalance] = useState({ bjt: 100, stars: 0 });
  const [connectionStatus, setConnectionStatus] = useState('offline');
  const [participants, setParticipants] = useState([]);

  const isAdmin = Number(user?.id) === ADMIN_ID;

  useEffect(() => {
    let mounted = true;

    async function initVK() {
      try {
        await bridge.send('VKWebAppInit');
        const info = await bridge.send('VKWebAppGetUserInfo');
        if (mounted && info?.id) {
          setUser(info);
          setVkReady(true);
        }
      } catch (error) {
        console.info('VK Bridge unavailable, demo mode enabled:', error?.message || error);
        
        // Проверить подпись VK в URL параметрах (если в демо-режиме без VK Bridge)
        const queryString = window.location.search.slice(1);
        if (queryString) {
          try {
            const response = await fetch(`/api/vk-check${LAUNCH_PARAMS ? `?${LAUNCH_PARAMS}` : ''}`);
            const data = await response.json();
            if (data.valid) {
              console.log('✅ VK signature valid for user:', data.userId);
            } else if (data.warning) {
              console.warn('⚠️ ' + data.warning);
            }
          } catch {
            console.log('Could not verify VK signature');
          }
        }
        
        setVkReady(false);
      }
    }

    initVK();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed.messages)) setMessages(parsed.messages);
      if (parsed.balance) setBalance(parsed.balance);
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ messages, balance }));
  }, [messages, balance]);

  useEffect(() => {
    const socketUrl = import.meta.env.VITE_SOCKET_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '/');
    const nextSocket = io(socketUrl, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      timeout: 2500,
      auth: { launchParams: LAUNCH_PARAMS }
    });

    nextSocket.on('connect', () => {
      setConnectionStatus('online');
      nextSocket.emit('user:join', normalizeUser(user));
    });

    nextSocket.on('connect_error', () => setConnectionStatus('demo'));
    nextSocket.on('disconnect', () => setConnectionStatus('offline'));
    nextSocket.on('app:error', (error) => {
      if (error?.message) addSystemMessage(error.message);
    });
    nextSocket.on('error', (error) => {
      const message = typeof error === 'string' ? error : error?.message;
      if (message) addSystemMessage(message);
    });
    nextSocket.on('state:init', (payload) => {
      if (Array.isArray(payload.messages)) setMessages(payload.messages);
      if (payload.balance) setBalance(payload.balance);
      if (Array.isArray(payload.users)) setParticipants(payload.users);
    });
    nextSocket.on('users:update', (users) => setParticipants(Array.isArray(users) ? users : []));
    nextSocket.on('chat:message', (message) => {
      setMessages((prev) => [...prev.slice(-99), message]);
    });
    nextSocket.on('wallet:update', (nextBalance) => {
      setBalance(nextBalance);
    });

    setSocket(nextSocket);
    return () => nextSocket.close();
  }, []);

  useEffect(() => {
    if (socket?.connected) socket.emit('user:join', normalizeUser(user));
  }, [socket, user]);

  function sendMessage(text) {
    const clean = text.trim();
    if (!clean) return;

    if (socket?.connected) {
      socket.emit('chat:send', { text: clean });
      return;
    }

    setMessages((prev) => [
      ...prev.slice(-99),
      {
        id: makeRequestId('local'),
        userId: user.id,
        name: displayName(user),
        avatar: user.photo_100,
        text: clean,
        createdAt: new Date().toISOString()
      }
    ]);
  }

  function convertBjtToStars(amount) {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return;

    if (socket?.connected) {
      socket.emit('shop:convert', { bjt: value, requestId: makeRequestId('convert') }, (result) => {
        if (result && result.ok === false && result.message) addSystemMessage(result.message);
      });
      return;
    }

    setBalance((prev) => {
      if (prev.bjt < value) return prev;
      return { bjt: prev.bjt - value, stars: prev.stars + value * 2 };
    });
  }


  function addSystemMessage(text) {
    setMessages((prev) => [
      ...prev.slice(-99),
      {
        id: makeRequestId('system'),
        userId: 0,
        name: 'Система',
        avatar: SPLASH_IMAGE,
        text,
        createdAt: new Date().toISOString(),
        system: true
      }
    ]);
  }

  function grantCurrency(targetId, currency, amount) {
    if (!isAdmin) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return;

    if (socket?.connected) {
      socket.emit('admin:grant', {
        targetId: Number(targetId),
        currency,
        amount: value,
        reason: 'Подарок тестеру',
        requestId: makeRequestId('grant')
      }, (result) => {
        if (result && result.ok === false && result.message) addSystemMessage(result.message);
      });
      return;
    }

    if (Number(targetId) === Number(user.id)) {
      setBalance((prev) => ({ ...prev, [currency]: prev[currency] + value }));
    }
  }

  if (screen === 'splash') {
    return <SplashScreen user={user} vkReady={vkReady} onEnter={() => setScreen('app')} />;
  }

  return (
    <main className="app-shell" style={{ '--splash-image': `url("${SPLASH_IMAGE}")` }}>
      <TopBar user={user} balance={balance} status={connectionStatus} isAdmin={isAdmin} />
      <nav className="main-nav" aria-label="Главное меню">
        <NavButton active={activeSection === 'home'} onClick={() => setActiveSection('home')}>Главная</NavButton>
        <NavButton active={activeSection === 'shop'} onClick={() => setActiveSection('shop')}>Магазин</NavButton>
        <NavButton active={activeSection === 'bar'} onClick={() => setActiveSection('bar')}>БАР Знакомств!</NavButton>
      </nav>

      {activeSection === 'home' && <HomeSection onGoBar={() => setActiveSection('bar')} onGoShop={() => setActiveSection('shop')} />}
      {activeSection === 'shop' && <ShopSection balance={balance} onConvert={convertBjtToStars} />}
      {activeSection === 'bar' && (
        <BarSection
          user={user}
          isAdmin={isAdmin}
          messages={messages}
          participants={participants}
          onSend={sendMessage}
          onGrant={grantCurrency}
        />
      )}
    </main>
  );
}

function SplashScreen({ user, vkReady, onEnter }) {
  return (
    <section className="splash" style={{ backgroundImage: `linear-gradient(90deg, rgba(0,0,0,.82), rgba(0,0,0,.28)), url("${SPLASH_IMAGE}")` }}>
      <div className="smoke smoke-a" />
      <div className="smoke smoke-b" />
      <div className="splash-card">
        <p className="eyebrow">VK Mini App #{APP_ID}</p>
        <h1>БАР Знакомств!</h1>
        <p className="lead">Закрытая комната с большим чатом, барным столиком-рамкой и внутренней валютой BJT.</p>
        <div className="splash-user">
          <img src={user.photo_100 || SPLASH_IMAGE} alt="Аватар пользователя" />
          <div>
            <strong>{displayName(user)}</strong>
            <span>{vkReady ? 'Профиль получен через VK Bridge' : 'Демо-режим вне VK'}</span>
          </div>
        </div>
        <button className="primary-button" onClick={onEnter}>Войти в бар</button>
      </div>
    </section>
  );
}

function TopBar({ user, balance, status, isAdmin }) {
  const label = status === 'online' ? 'сервер онлайн' : status === 'demo' ? 'демо без сервера' : 'подключение...';
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">BJT</span>
        <div>
          <strong>БАР Знакомств!</strong>
          <span>VK ID: {user.id}{isAdmin ? ' · Админ' : ''}</span>
        </div>
      </div>
      <div className="wallet">
        <span className="wallet-pill coin">₿ {balance.bjt} BJT</span>
        <span className="wallet-pill star">★ {balance.stars}</span>
        <span className={`status status-${status}`}>{label}</span>
      </div>
    </header>
  );
}

function NavButton({ active, children, ...props }) {
  return <button className={active ? 'nav-button active' : 'nav-button'} {...props}>{children}</button>;
}

function HomeSection({ onGoBar, onGoShop }) {
  return (
    <section className="home-grid">
      <article className="hero-panel">
        <p className="eyebrow">Главное меню</p>
        <h2>Комната, где барный столик слева, чат справа</h2>
        <p>Собрали стартовую версию: заставка, магазин валюты, отдельная комната бара, лёгкий барный столик-рамка и чат с именем пользователя, датой и временем.</p>
        <div className="hero-actions">
          <button className="primary-button" onClick={onGoBar}>Открыть БАР</button>
          <button className="ghost-button" onClick={onGoShop}>Магазин</button>
        </div>
      </article>
      <article className="rules-panel">
        <h3>Экономика</h3>
        <p><b>10 BJT</b> = 1 голосу VK = 7 рублям</p>
        <p><b>10 BJT</b> = 20 звёздам</p>
        <p>Админ VK ID 1057236881 может начислять валюту тестерам.</p>
      </article>
    </section>
  );
}

function ShopSection({ balance, onConvert }) {
  const [amount, setAmount] = useState(10);
  const stars = Number(amount || 0) * 2;

  return (
    <section className="shop-section">
      <div className="section-heading">
        <p className="eyebrow">Магазин</p>
        <h2>Валюта BJT и звёзды</h2>
        <p>Покупки через VK Голоса подключаются следующим шагом. Сейчас работает демо-баланс и конвертация BJT в звёзды.</p>
      </div>
      <div className="shop-grid">
        {shopProducts.map((product) => (
          <article className="shop-card" key={product.title}>
            <div className="shop-icon">{product.icon}</div>
            <h3>{product.title}</h3>
            <p>{product.subtitle}</p>
            <strong>{product.value}</strong>
          </article>
        ))}
      </div>
      <div className="converter-card">
        <div>
          <h3>Конвертация</h3>
          <p>На балансе: {balance.bjt} BJT и {balance.stars} ★</p>
        </div>
        <label>
          BJT
          <input type="number" min="10" step="10" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </label>
        <span className="converter-result">→ {stars || 0} ★</span>
        <button className="primary-button" onClick={() => onConvert(amount)}>Обменять</button>
      </div>
    </section>
  );
}

function BarSection({ user, isAdmin, messages, participants = [], onSend, onGrant }) {
  return (
    <section className="bar-layout">
      <div className="table-zone">
        <div className="section-heading compact">
          <p className="eyebrow">Отдельная комната</p>
          <h2>БАР Знакомств!</h2>
        </div>
        <Suspense fallback={<div className="canvas-card"><div className="loading-3d">Готовлю барный столик...</div></div>}><BarTableScene participants={participants} user={user} /></Suspense>
        <div className="table-caption">
          <span>Тяжёлый 3D-стол вырезан: осталась лёгкая рамка барного столика</span>
          <span>Участники занимают фиксированные места по кругу, бутылка крутится по клику</span>
        </div>
      </div>
      <aside className="chat-zone">
        <ChatPanel user={user} messages={messages} onSend={onSend} />
        {isAdmin && <AdminPanel currentUserId={user.id} onGrant={onGrant} />}
      </aside>
    </section>
  );
}


function ChatPanel({ user, messages, onSend }) {
  const [draft, setDraft] = useState('');
  const listRef = useRef(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  function submit(event) {
    event.preventDefault();
    onSend(draft);
    setDraft('');
  }

  return (
    <div className="chat-card">
      <div className="chat-header">
        <div>
          <h3>Большой чат</h3>
          <p>Сообщения: имя, дата и время</p>
        </div>
        <img src={user.photo_100 || SPLASH_IMAGE} alt="Ваш аватар" />
      </div>
      <div className="message-list" ref={listRef}>
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} mine={Number(message.userId) === Number(user.id)} />
        ))}
      </div>
      <form className="chat-form" onSubmit={submit}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Написать в БАР..."
          maxLength={500}
        />
        <button className="primary-button" type="submit">Отправить</button>
      </form>
    </div>
  );
}

function MessageBubble({ message, mine }) {
  const date = new Date(message.createdAt);
  return (
    <article className={message.system ? 'message system' : mine ? 'message mine' : 'message'}>
      <img src={message.avatar || SPLASH_IMAGE} alt="" />
      <div>
        <header>
          <strong>{message.name}</strong>
          <time dateTime={message.createdAt}>{date.toLocaleDateString('ru-RU')} · {date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</time>
        </header>
        <p>{message.text}</p>
      </div>
    </article>
  );
}

function AdminPanel({ currentUserId, onGrant }) {
  const [targetId, setTargetId] = useState(currentUserId);
  const [currency, setCurrency] = useState('bjt');
  const [amount, setAmount] = useState(100);

  return (
    <div className="admin-panel">
      <div>
        <h3>Админ-панель</h3>
        <p>Начисление валюты тестерам и подарки.</p>
      </div>
      <label>
        VK ID получателя
        <input value={targetId} onChange={(event) => setTargetId(event.target.value)} inputMode="numeric" />
      </label>
      <label>
        Валюта
        <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
          <option value="bjt">BJT</option>
          <option value="stars">Звёзды</option>
        </select>
      </label>
      <label>
        Количество
        <input type="number" min="1" value={amount} onChange={(event) => setAmount(event.target.value)} />
      </label>
      <button className="ghost-button" onClick={() => onGrant(targetId, currency, amount)}>Начислить</button>
    </div>
  );
}

function normalizeUser(rawUser) {
  return {
    id: Number(rawUser?.id) || fallbackUser.id,
    first_name: rawUser?.first_name || 'Гость',
    last_name: rawUser?.last_name || '',
    photo_100: rawUser?.photo_100 || SPLASH_IMAGE,
    joinedAt: rawUser?.joinedAt || null
  };
}

function makeRequestId(prefix = 'request') {
  if (globalThis.crypto?.randomUUID) return `${prefix}:${globalThis.crypto.randomUUID()}`;
  return `${prefix}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

function displayName(rawUser) {
  const user = normalizeUser(rawUser);
  return `${user.first_name} ${user.last_name}`.trim();
}

createRoot(document.getElementById('root')).render(<App />);
