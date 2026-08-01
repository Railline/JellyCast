using System.Reflection;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyCast.Controllers;

/// <summary>Serves the embedded JellyCast web client.</summary>
[ApiController]
[Route("JellyCast")]
public sealed class JellyCastController : ControllerBase
{
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
}
