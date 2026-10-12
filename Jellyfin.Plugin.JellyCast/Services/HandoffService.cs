using System.Collections.Concurrent;

namespace Jellyfin.Plugin.JellyCast.Services;

/// <summary>Coordinates a short-lived request for the source client to stop locally.</summary>
public sealed class HandoffService
{
    private static readonly TimeSpan HandoffLifetime = TimeSpan.FromSeconds(30);
    private readonly ConcurrentDictionary<Guid, HandoffState> _handoffs = new();

    internal HandoffState Create(Guid userId, string sourceDeviceId, string itemId)
    {
        CleanupExpired();
        var state = new HandoffState(
            Guid.NewGuid(),
            userId,
            sourceDeviceId,
            itemId,
            DateTimeOffset.UtcNow.Add(HandoffLifetime),
            false);
        _handoffs[state.Id] = state;
        return state;
    }

    internal HandoffState? Get(Guid id, Guid userId)
    {
        CleanupExpired();
        return _handoffs.TryGetValue(id, out var state) && state.UserId == userId
            ? state
            : null;
    }

    internal HandoffState? GetPending(Guid userId, string deviceId)
    {
        CleanupExpired();
        return _handoffs.Values
            .Where(state => state.UserId == userId
                && !state.Acknowledged
                && IsSamePhysicalDevice(state.SourceDeviceId, deviceId))
            .OrderByDescending(state => state.ExpiresAtUtc)
            .FirstOrDefault();
    }

    internal bool Acknowledge(Guid id, Guid userId, string deviceId)
    {
        CleanupExpired();
        while (_handoffs.TryGetValue(id, out var state))
        {
            if (state.UserId != userId
                || !IsSamePhysicalDevice(state.SourceDeviceId, deviceId))
            {
                return false;
            }

            if (state.Acknowledged)
            {
                return true;
            }

            if (_handoffs.TryUpdate(id, state with { Acknowledged = true }, state))
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsSamePhysicalDevice(string firstId, string secondId)
    {
        if (string.IsNullOrWhiteSpace(firstId) || string.IsNullOrWhiteSpace(secondId))
        {
            return false;
        }

        return firstId.Equals(secondId, StringComparison.OrdinalIgnoreCase)
            || firstId.StartsWith(secondId, StringComparison.OrdinalIgnoreCase)
            || secondId.StartsWith(firstId, StringComparison.OrdinalIgnoreCase);
    }

    private void CleanupExpired()
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var entry in _handoffs)
        {
            if (entry.Value.ExpiresAtUtc <= now)
            {
                _handoffs.TryRemove(entry.Key, out _);
            }
        }
    }
}
