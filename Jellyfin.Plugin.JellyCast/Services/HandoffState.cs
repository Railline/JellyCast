namespace Jellyfin.Plugin.JellyCast.Services;

internal sealed record HandoffState(
    Guid Id,
    Guid UserId,
    string SourceDeviceId,
    string ItemId,
    DateTimeOffset ExpiresAtUtc,
    bool Acknowledged);
