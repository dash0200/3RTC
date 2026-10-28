/**
 * Tycoon's board: 40 spaces around a square, famous streets and places around the world.
 * Spaces 0 Start, 10 Jail, 20 Coffee Break, 30 Go to Jail are the corners.
 */

export type GroupId = 'brown' | 'sky' | 'pink' | 'orange' | 'red' | 'yellow' | 'green' | 'navy';

export type Space =
  | { kind: 'start'; name: string }
  | { kind: 'jail'; name: string }
  | { kind: 'parking'; name: string }
  | { kind: 'gotojail'; name: string }
  | { kind: 'property'; name: string; city: string; group: GroupId; price: number; rent: number[]; house: number }
  | { kind: 'station'; name: string; price: number }
  | { kind: 'utility'; name: string; price: number; icon: 'power' | 'water' }
  | { kind: 'tax'; name: string; amount: number }
  | { kind: 'surprise'; name: string }
  | { kind: 'treasure'; name: string };

export const GROUP_COLORS: Record<GroupId, string> = {
  brown: '#8a5a3c',
  sky: '#7cc6ee',
  pink: '#d6589a',
  orange: '#f08a24',
  red: '#e0393e',
  yellow: '#f2cb05',
  green: '#1f9d55',
  navy: '#2a4fb5'
};

/** Colour names as people say them (the build hints, the guide) */
export const GROUP_NAMES: Record<GroupId, string> = {
  brown: 'brown',
  sky: 'light blue',
  pink: 'pink',
  orange: 'orange',
  red: 'red',
  yellow: 'yellow',
  green: 'green',
  navy: 'dark blue'
};

const P = (name: string, city: string, group: GroupId, price: number, rent: number[], house: number): Space => ({
  kind: 'property', name, city, group, price, rent, house
});

export const SPACES: Space[] = [
  { kind: 'start', name: 'Start' },
  P('Khao San Road', 'Bangkok', 'brown', 600, [20, 100, 300, 900, 1600, 2500], 500),
  { kind: 'treasure', name: 'Treasure' },
  P('Grand Bazaar', 'Istanbul', 'brown', 600, [40, 200, 600, 1800, 3200, 4500], 500),
  { kind: 'tax', name: 'Income Tax', amount: 2000 },
  { kind: 'station', name: 'Central Station', price: 2000 },
  P('La Rambla', 'Barcelona', 'sky', 1000, [60, 300, 900, 2700, 4000, 5500], 500),
  { kind: 'surprise', name: 'Surprise' },
  P('Copacabana', 'Rio de Janeiro', 'sky', 1000, [60, 300, 900, 2700, 4000, 5500], 500),
  P('Nyhavn', 'Copenhagen', 'sky', 1200, [80, 400, 1000, 3000, 4500, 6000], 500),
  { kind: 'jail', name: 'Jail' },
  P('Nanjing Road', 'Shanghai', 'pink', 1400, [100, 500, 1500, 4500, 6250, 7500], 1000),
  { kind: 'utility', name: 'Power Grid', price: 1500, icon: 'power' },
  P('Orchard Road', 'Singapore', 'pink', 1400, [100, 500, 1500, 4500, 6250, 7500], 1000),
  P('Bondi Beach', 'Sydney', 'pink', 1600, [120, 600, 1800, 5000, 7000, 9000], 1000),
  { kind: 'station', name: 'Metro Line', price: 2000 },
  P('Unter den Linden', 'Berlin', 'orange', 1800, [140, 700, 2000, 5500, 7500, 9500], 1000),
  { kind: 'treasure', name: 'Treasure' },
  P('Dam Square', 'Amsterdam', 'orange', 1800, [140, 700, 2000, 5500, 7500, 9500], 1000),
  P('Gran Vía', 'Madrid', 'orange', 2000, [160, 800, 2200, 6000, 8000, 10000], 1000),
  { kind: 'parking', name: 'Coffee Break' },
  P('Myeongdong', 'Seoul', 'red', 2200, [180, 900, 2500, 7000, 8750, 10500], 1500),
  { kind: 'surprise', name: 'Surprise' },
  P('Marine Drive', 'Mumbai', 'red', 2200, [180, 900, 2500, 7000, 8750, 10500], 1500),
  P('Oxford Street', 'London', 'red', 2400, [200, 1000, 3000, 7500, 9250, 11000], 1500),
  { kind: 'station', name: 'Airport Express', price: 2000 },
  P('Via del Corso', 'Rome', 'yellow', 2600, [220, 1100, 3300, 8000, 9750, 11500], 1500),
  P('The Strip', 'Las Vegas', 'yellow', 2600, [220, 1100, 3300, 8000, 9750, 11500], 1500),
  { kind: 'utility', name: 'Water Works', price: 1500, icon: 'water' },
  P('Champs-Élysées', 'Paris', 'yellow', 2800, [240, 1200, 3600, 8500, 10250, 12000], 1500),
  { kind: 'gotojail', name: 'Go to Jail' },
  P('Rodeo Drive', 'Beverly Hills', 'green', 3000, [260, 1300, 3900, 9000, 11000, 12750], 2000),
  P('Ginza', 'Tokyo', 'green', 3000, [260, 1300, 3900, 9000, 11000, 12750], 2000),
  { kind: 'treasure', name: 'Treasure' },
  P('Sheikh Zayed Road', 'Dubai', 'green', 3200, [280, 1500, 4500, 10000, 12000, 14000], 2000),
  { kind: 'station', name: 'Harbour Port', price: 2000 },
  { kind: 'surprise', name: 'Surprise' },
  P('Fifth Avenue', 'New York', 'navy', 3500, [350, 1750, 5000, 11000, 13000, 15000], 2000),
  { kind: 'tax', name: 'Luxury Tax', amount: 1000 },
  P('Monte Carlo', 'Monaco', 'navy', 4000, [500, 2000, 6000, 14000, 17000, 20000], 2000)
];

export const JAIL = 10;
export const GO_TO_JAIL = 30;
export const START_PAY = 2000;
export const START_CASH = 15000;
export const JAIL_FINE = 500;
export const STATION_RENT = [250, 500, 1000, 2000];
export const UTILITY_TIMES = [40, 100]; // × dice total, for 1 or 2 owned

export const isBuyable = (i: number): boolean => ['property', 'station', 'utility'].includes(SPACES[i].kind);
export const priceOf = (i: number): number => {
  const s = SPACES[i];
  return s.kind === 'property' || s.kind === 'station' || s.kind === 'utility' ? s.price : 0;
};
export const groupOf = (i: number): GroupId | null => {
  const s = SPACES[i];
  return s.kind === 'property' ? s.group : null;
};
export const groupMembers = (g: GroupId): number[] => SPACES.map((s, i) => (s.kind === 'property' && s.group === g ? i : -1)).filter((i) => i >= 0);
export const STATIONS = SPACES.map((s, i) => (s.kind === 'station' ? i : -1)).filter((i) => i >= 0);
export const UTILITIES = SPACES.map((s, i) => (s.kind === 'utility' ? i : -1)).filter((i) => i >= 0);

// ---- cards (our own) ----------------------------------------------------------------------

export type CardEffect =
  | { type: 'money'; amount: number } // + gets, − pays the bank
  | { type: 'each'; amount: number } // + every other player pays you, − you pay each
  | { type: 'moveTo'; to: number } // collect Start money when passing it
  | { type: 'back'; spaces: number }
  | { type: 'nearest'; what: 'station' | 'utility' } // pay double / 10× dice if owned
  | { type: 'jail' }
  | { type: 'jailFree' }
  | { type: 'repairs'; house: number; hotel: number };

export interface TycoonCard {
  text: string;
  effect: CardEffect;
}

export const SURPRISE: TycoonCard[] = [
  { text: 'Your startup got funded! Advance to Start.', effect: { type: 'moveTo', to: 0 } },
  { text: 'Weekend in Paris: go to Champs-Élysées.', effect: { type: 'moveTo', to: 29 } },
  { text: 'Shopping spree: head to Oxford Street.', effect: { type: 'moveTo', to: 24 } },
  { text: 'Catch a train: go to Central Station.', effect: { type: 'moveTo', to: 5 } },
  { text: 'Feeling lucky? Head to Monte Carlo.', effect: { type: 'moveTo', to: 39 } },
  { text: 'Rush to the nearest station. If someone owns it, pay them double.', effect: { type: 'nearest', what: 'station' } },
  { text: 'Rush to the nearest station. If someone owns it, pay them double.', effect: { type: 'nearest', what: 'station' } },
  { text: 'Go to the nearest utility. If owned, pay 10× your dice roll.', effect: { type: 'nearest', what: 'utility' } },
  { text: 'Your shares paid a dividend. Collect $500.', effect: { type: 'money', amount: 500 } },
  { text: 'Lucky escape! Keep this card to get out of jail free.', effect: { type: 'jailFree' } },
  { text: 'Wrong turn at the roundabout. Go back 3 spaces.', effect: { type: 'back', spaces: 3 } },
  { text: 'Caught running a red light. Go straight to Jail.', effect: { type: 'jail' } },
  { text: 'Storm damage: pay $250 per house and $1,000 per hotel.', effect: { type: 'repairs', house: 250, hotel: 1000 } },
  { text: 'Speeding ticket: pay $150.', effect: { type: 'money', amount: -150 } },
  { text: 'You were elected club chairperson. Pay each player $500.', effect: { type: 'each', amount: -500 } },
  { text: 'Your savings bond matured. Collect $1,500.', effect: { type: 'money', amount: 1500 } }
];

export const TREASURE: TycoonCard[] = [
  { text: 'Holiday bonus! Advance to Start.', effect: { type: 'moveTo', to: 0 } },
  { text: 'The bank made a mistake in your favour. Collect $2,000.', effect: { type: 'money', amount: 2000 } },
  { text: 'Dentist visit. Pay $500.', effect: { type: 'money', amount: -500 } },
  { text: 'You sold some old gold. Collect $500.', effect: { type: 'money', amount: 500 } },
  { text: 'A wise elder’s blessing: keep this card to get out of jail free.', effect: { type: 'jailFree' } },
  { text: 'Tax raid! Go straight to Jail.', effect: { type: 'jail' } },
  { text: 'It’s your birthday! Collect $100 from every player.', effect: { type: 'each', amount: 100 } },
  { text: 'Income tax refund. Collect $200.', effect: { type: 'money', amount: 200 } },
  { text: 'Your life insurance matured. Collect $1,000.', effect: { type: 'money', amount: 1000 } },
  { text: 'Hospital bill. Pay $1,000.', effect: { type: 'money', amount: -1000 } },
  { text: 'School fees are due. Pay $500.', effect: { type: 'money', amount: -500 } },
  { text: 'Freelance project paid off. Collect $250.', effect: { type: 'money', amount: 250 } },
  { text: 'Building maintenance: pay $400 per house and $1,150 per hotel.', effect: { type: 'repairs', house: 400, hotel: 1150 } },
  { text: 'Second prize in a baking contest! Collect $100.', effect: { type: 'money', amount: 100 } },
  { text: 'An uncle left you some savings. Collect $1,000.', effect: { type: 'money', amount: 1000 } },
  { text: 'You won the office lottery. Collect $1,000.', effect: { type: 'money', amount: 1000 } }
];

export const TOKENS = ['auto', 'car', 'scooter', 'boat', 'plane', 'train'] as const;
export type TokenId = (typeof TOKENS)[number];
export const PLAYER_COLORS = ['#e5484d', '#2f7fe0', '#2fa84f', '#f2b705', '#a855f7', '#f97316'];
export const MAX_PLAYERS = 6;
