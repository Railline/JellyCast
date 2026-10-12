using System.Reflection;
using System.Security.Claims;
using Jellyfin.Plugin.JellyCast.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyCast.Controllers;

/// <summary>Serves the embedded JellyCast web client.</summary>
[ApiController]
[Route("JellyCast")]
public sealed class JellyCastController : ControllerBase
{
    private const string UserIdClaim = "Jellyfin-UserId";

    private static readonly Action<ILogger, string, string, string, string, Exception?>
        LogClientDiagnostic = LoggerMessage.Define<string, string, string, string>(
            LogLevel.Warning,
            new EventId(1001, "ClientDiagnostic"),
            "JellyCast client diagnostic. Version: {ClientVersion}; Stage: {Stage}; "
            + "Device: {DeviceId}; Error: {Message}");

    private readonly HandoffService _handoffService;
    private readonly ILogger<JellyCastController> _logger;

    /// <summary>Initializes a new instance of the <see cref="JellyCastController"/> class.</summary>
    public JellyCastController(
        HandoffService handoffService,
        ILogger<JellyCastController> logger)
    {
        _handoffService = handoffService;
        _logger = logger;
    }

    /// <summary>Returns the JellyCast browser script.</summary>
    [HttpGet("Client.js")]
    [AllowAnonymous]
    [ResponseCache(Duration = 0, Location = ResponseCacheLocation.None, NoStore = true)]
    [Produces("application/javascript")]
    public ActionResult GetClientScript()
    {
        Response.Headers["Cache-Control"] = "no-store, no-cache, must-revalidate";
        Response.Headers["Pragma"] = "no-cache";
        Response.Headers["Expires"] = "0";

        var assembly = typeof(JellyCastController).Assembly;
        using var stream = assembly.GetManifestResourceStream(
            "Jellyfin.Plugin.JellyCast.Web.jellycast.js");

        if (stream is null)
        {
            return NotFound();
        }

        using var reader = new StreamReader(stream);
        return Content(reader.ReadToEnd(), "application/javascript; charset=utf-8");
    }

    /// <summary>Creates a short-lived source-device handoff.</summary>
    [HttpPost("Handoffs")]
    [Authorize]
    public ActionResult CreateHandoff(
        [FromQuery] string sourceDeviceId,
        [FromQuery] string itemId)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return Unauthorized();
        }

        if (string.IsNullOrWhiteSpace(sourceDeviceId) || string.IsNullOrWhiteSpace(itemId))
        {
            return BadRequest();
        }

        return Ok(ToResponse(_handoffService.Create(userId, sourceDeviceId, itemId)));
    }

    /// <summary>Returns the newest pending handoff for the current device.</summary>
    [HttpGet("Handoffs/Pending")]
    [Authorize]
    public ActionResult GetPendingHandoff([FromQuery] string deviceId)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return Unauthorized();
        }

        var handoff = string.IsNullOrWhiteSpace(deviceId)
            ? null
            : _handoffService.GetPending(userId, deviceId);
        return handoff is null ? Ok(new { Id = (Guid?)null }) : Ok(ToResponse(handoff));
    }

    /// <summary>Returns a handoff owned by the current user.</summary>
    [HttpGet("Handoffs/{id:guid}")]
    [Authorize]
    public ActionResult GetHandoff([FromRoute] Guid id)
    {
        var handoff = _handoffService.Get(id, GetUserId());
        return handoff is null ? NotFound() : Ok(ToResponse(handoff));
    }

    /// <summary>Acknowledges that the source device stopped its local player.</summary>
    [HttpPost("Handoffs/{id:guid}/Acknowledge")]
    [Authorize]
    public ActionResult AcknowledgeHandoff([FromRoute] Guid id, [FromQuery] string deviceId)
    {
        if (string.IsNullOrWhiteSpace(deviceId))
        {
            return BadRequest();
        }

        return _handoffService.Acknowledge(id, GetUserId(), deviceId)
            ? NoContent()
            : NotFound();
    }

    /// <summary>Writes a deduplicated browser diagnostic to the Jellyfin log.</summary>
    [HttpPost("Diagnostics")]
    [Authorize]
    public ActionResult ReportDiagnostic(
        [FromQuery] string stage,
        [FromQuery] string message,
        [FromQuery] string deviceId,
        [FromQuery] string clientVersion)
    {
        LogClientDiagnostic(_logger, clientVersion, stage, deviceId, message, null);
        return NoContent();
    }

    private Guid GetUserId()
    {
        var value = User.Claims.FirstOrDefault(claim =>
            claim.Type.Equals(UserIdClaim, StringComparison.OrdinalIgnoreCase))?.Value;
        return Guid.TryParse(value, out var userId) ? userId : Guid.Empty;
    }

    private static object ToResponse(HandoffState state) => new
    {
        state.Id,
        state.SourceDeviceId,
        state.ItemId,
        state.Acknowledged
    };
}
