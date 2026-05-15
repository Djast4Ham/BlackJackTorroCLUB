import React, { useMemo, useState } from 'react';
import { SPLASH_IMAGE } from './assets.js';

const SEAT_COUNT = 12;

export default function BarTableScene({ participants = [], user }) {
  const [spinning, setSpinning] = useState(false);
  const seatedParticipants = useSeatedParticipants(participants, user, SEAT_COUNT);

  return (
    <div className="canvas-card table-frame-card" role="img" aria-label="Барный столик-рамка с местами участников по кругу">
      <div className="bar-table-ambient" />
      <div className="bar-table-ring outer" />
      <div className="bar-table-ring middle" />
      <div className="bar-table-ring inner" />
      <div className="bar-table-sparkles" aria-hidden="true">
        {Array.from({ length: 16 }).map((_, index) => (
          <span key={index} style={overlayPosition(index, 16, 33, 25)} />
        ))}
      </div>

      {Array.from({ length: SEAT_COUNT }).map((_, index) => {
        const person = seatedParticipants[index];
        return (
          <div className="css-seat scene-overlay" style={overlayPosition(index, SEAT_COUNT, 38, 31)} key={`seat-${index}`}>
            <span className="css-seat-back" />
            <span className="css-seat-base" />
            <span className="css-seat-leg" />
            <span className="seat-number">{index + 1}</span>
            {person && (
              <span className="seat-name">
                <span>{displayName(person)}</span>
              </span>
            )}
          </div>
        );
      })}

      <button
        type="button"
        className={spinning ? 'css-bottle spinning' : 'css-bottle'}
        onClick={() => setSpinning((value) => !value)}
        aria-pressed={spinning}
        aria-label="Крутить бутылочку"
        title="Клик — крутить бутылочку"
      >
        <span className="bottle-body" />
        <span className="bottle-neck" />
        <span className="bottle-label" />
      </button>

      <div className="table-center-label scene-overlay scene-center">Барный столик</div>
      <div className="table-click-hint scene-overlay">нажми на бутылочку</div>
    </div>
  );
}

function useSeatedParticipants(participants = [], currentUser, seatCount = SEAT_COUNT) {
  return useMemo(() => {
    const unique = new Map();
    const add = (person) => {
      if (!person?.id) return;
      const normalized = normalizeUser(person);
      if (!unique.has(Number(normalized.id))) unique.set(Number(normalized.id), normalized);
    };

    add(currentUser);
    participants.forEach(add);

    return Array.from(unique.values())
      .sort((a, b) => String(a.joinedAt || '').localeCompare(String(b.joinedAt || '')) || Number(a.id) - Number(b.id))
      .slice(0, seatCount);
  }, [participants, currentUser, seatCount]);
}

function overlayPosition(index, total, radiusX, radiusY) {
  const angle = (index / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2;
  return {
    left: `${50 + Math.cos(angle) * radiusX}%`,
    top: `${50 + Math.sin(angle) * radiusY}%`
  };
}

function normalizeUser(rawUser) {
  return {
    id: Number(rawUser?.id) || 0,
    first_name: rawUser?.first_name || 'Гость',
    last_name: rawUser?.last_name || '',
    photo_100: rawUser?.photo_100 || SPLASH_IMAGE,
    joinedAt: rawUser?.joinedAt || null
  };
}

function displayName(rawUser) {
  const user = normalizeUser(rawUser);
  return `${user.first_name} ${user.last_name}`.trim();
}
