import { spawnSync } from "node:child_process";

export type ContainerEngine = "docker" | "podman";

const detected = new Map<string, ContainerEngine>();

/**
 * Which engine answers to `command`. Podman (directly, via the podman-docker
 * shim, or via a `docker` symlink) accepts the Docker CLI except for a few
 * flags, so docker-local speaks a small dialect instead of a separate provider.
 * Detected once per command; anything that is not Podman is treated as Docker.
 */
export function detectContainerEngine(command: string): ContainerEngine {
  let engine = detected.get(command);
  if (engine === undefined) {
    // Not `--version`: Podman names itself after argv[0], so a `docker`
    // symlink prints "docker version …". `version` always reports the client
    // engine. Match the client only: a Docker CLI pointed at a Podman socket
    // still sends Docker flags.
    const result = spawnSync(command, ["version"], { encoding: "utf8" });
    engine = /^Client:\s*Podman/m.test(result.stdout ?? "") ? "podman" : "docker";
    detected.set(command, engine);
  }
  return engine;
}

/**
 * tmpfs ownership option for a mount owned by `uid` (same gid). Docker takes
 * `uid=`/`gid=`; Podman 4.x rejects them ("unknown mount option") and instead
 * offers `U`, which chowns the mount to the container's `--user`. Root
 * ownership is Podman's default, so uid 0 needs no option there.
 */
export function tmpfsOwnerOption(engine: ContainerEngine, uid: number): string {
  if (engine === "podman") return uid === 0 ? "" : ",U";
  return `,uid=${uid},gid=${uid}`;
}
