#!/usr/bin/env bash
# Shared scope selection for setup.sh user services and existing system services.
# Read-only discovery; mutations go through nexus_systemctl.
nexus_resolve_service_scope() {
    local requested="${NEXUS_SERVICE_SCOPE:-auto}"
    local service="${NEXUS_SERVICE_NAME:-nexus}"
    case "$service" in *.service) ;; *) service="${service}.service" ;; esac
    case "$requested" in
        user|system) NEXUS_SERVICE_SCOPE="$requested" ;;
        auto)
            local user_root system_root
            user_root="$(systemctl --user show "$service" -p WorkingDirectory --value 2>/dev/null || true)"
            system_root="$(systemctl show "$service" -p WorkingDirectory --value 2>/dev/null || true)"
            if [ -n "$user_root" ] && [ -n "$system_root" ]; then
                echo '[Nexus] Both user and system services exist. Set NEXUS_SERVICE_SCOPE=user or system.' >&2
                return 1
            elif [ -n "$user_root" ]; then
                NEXUS_SERVICE_SCOPE=user
            elif [ -n "$system_root" ]; then
                NEXUS_SERVICE_SCOPE=system
            else
                NEXUS_SERVICE_SCOPE=user
            fi
            ;;
        *) echo '[Nexus] NEXUS_SERVICE_SCOPE must be auto, user or system.' >&2; return 1 ;;
    esac
    export NEXUS_SERVICE_SCOPE
}

nexus_systemctl_query() {
    if [ "$NEXUS_SERVICE_SCOPE" = user ]; then systemctl --user "$@"; else systemctl "$@"; fi
}

nexus_systemctl() {
    if [ "$NEXUS_SERVICE_SCOPE" = user ]; then systemctl --user "$@"; else sudo -n systemctl "$@"; fi
}
