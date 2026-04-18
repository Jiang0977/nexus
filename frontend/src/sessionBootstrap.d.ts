export interface BootstrapProjectLike {
  name: string
}

export interface PickBootstrapSessionInput {
  storedSession?: string | null
  storedSessionSource?: string | null
  activeSession?: string | null
  defaultSession?: string | null
  projects?: BootstrapProjectLike[]
}

export function pickBootstrapSession(input: PickBootstrapSessionInput): string
export function sessionExists(session: string | null | undefined, projects: BootstrapProjectLike[]): boolean
