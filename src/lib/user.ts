import { USERS } from "../../shared/constants";
import type { User } from "../../shared/schema";
import { api } from "./api";
import { signal } from "./signal";

const KEY = "fd_user";

function stored(): User | undefined {
  try {
    const v = localStorage.getItem(KEY);
    return (USERS as readonly string[]).includes(v ?? "") ? (v as User) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Who is logged in, for display and optimistic UI only: the server attributes every change to
 * the session, whatever the client thinks. Cached so it is known offline. Before the first
 * /api/me answer on a device it is "max", and the next server copy corrects anything shown wrong.
 */
export const currentUser = signal<User>(stored() ?? "max");
export const userKnown = signal<boolean>(stored() !== undefined);

export async function refreshUser(): Promise<void> {
  try {
    const { user } = await api<{ user: User }>("/me");
    localStorage.setItem(KEY, user);
    currentUser.set(user);
    userKnown.set(true);
  } catch {
    // Offline or logged out: keep the cached value; the header shows the sync state.
  }
}

export function forgetUser(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: nothing to forget.
  }
}
