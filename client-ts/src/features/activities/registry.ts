/**
 * Activities: things a room does together besides watching (games, polls, a whiteboard...).
 *
 * To add one, create features/activities/<id>/index.tsx (default export: the component) and add
 * an entry below. Nothing else in the app needs to change: the menus list it, starting it shows
 * it to everyone in the room (people joining later too), and its code is downloaded only when
 * someone opens it. See docs/ADDING_A_FEATURE.md.
 *
 * Entry fields:
 *   id           stable, short, unique (part of message keys; never rename a shipped one)
 *   name, icon   shown in the menus
 *   description  one line for the menu
 *   minPeople    people needed in the room to start it (default 1)
 *   load         () => import('./<id>/index')
 */
import type { ComponentType } from 'react';

export interface ActivityDefinition {
  id: string;
  name: string;
  icon: string;
  description: string;
  minPeople?: number;
  load: () => Promise<{ default: ComponentType<{ activityId: string }> }>;
}

const SHIPPED: ActivityDefinition[] = [
  {
    id: 'ludo',
    name: 'Ludo',
    icon: '🎲',
    description: '2–4 players (or play the computer), everyone else watches',
    minPeople: 1,
    load: () => import('./ludo/index')
  }
];

// Development-only example (localhost / dev builds): shows the whole flow end to end
const DEV_ONLY: ActivityDefinition[] = import.meta.env?.DEV
  ? [
      {
        id: 'sample-counter',
        name: 'Sample counter',
        icon: '🧪',
        description: 'Dev example of a shared activity',
        minPeople: 1,
        load: () => import('./sample/index')
      }
    ]
  : [];

export const ACTIVITIES: ActivityDefinition[] = [...SHIPPED, ...DEV_ONLY];

export const findActivity = (id: string): ActivityDefinition | null =>
  ACTIVITIES.find((a) => a.id === id) || null;
