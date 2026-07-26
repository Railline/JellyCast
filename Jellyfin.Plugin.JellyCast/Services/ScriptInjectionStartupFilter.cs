using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.JellyCast.Services;

/// <summary>
/// Injects JellyCast into Jellyfin Web at response time without changing web files on disk.
/// </summary>
public sealed class ScriptInjectionStartupFilter : IStartupFilter
{
    private const string ScriptPath = "/JellyCast/Client.js";

    /// <inheritdoc />
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            app.Use(InjectAsync);
            next(app);
        };
    }

    private static async Task InjectAsync(HttpContext context, Func<Task> next)
    {
        if (!HttpMethods.IsGet(context.Request.Method) || !IsWebShell(context.Request.Path.Value))
        {
            await next().ConfigureAwait(false);
            return;
        }

        context.Request.Headers.Remove("Accept-Encoding");
        context.Request.Headers.Remove("Range");
        context.Request.Headers.Remove("If-Range");

        var originalBody = context.Response.Body;
        using var buffer = new MemoryStream();
        context.Response.Body = buffer;

        try
        {
            await next().ConfigureAwait(false);
        }
        catch
        {
            context.Response.Body = originalBody;
            throw;
        }

        context.Response.Body = originalBody;
        buffer.Position = 0;

        if (context.Response.StatusCode != StatusCodes.Status200OK
            || !(context.Response.ContentType?.Contains("text/html", StringComparison.OrdinalIgnoreCase) ?? false))
        {
            await buffer.CopyToAsync(originalBody).ConfigureAwait(false);
            return;
        }

        string html;
        using (var reader = new StreamReader(buffer, Encoding.UTF8, true, leaveOpen: true))
        {
            html = await reader.ReadToEndAsync().ConfigureAwait(false);
        }

        if (!html.Contains(ScriptPath, StringComparison.OrdinalIgnoreCase))
        {
            var closingBody = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
            if (closingBody >= 0)
            {
                var tag = $"<script src=\"{ScriptPath}\" defer></script>\n";
                html = html.Insert(closingBody, tag);
            }
        }

        var bytes = Encoding.UTF8.GetBytes(html);
        context.Response.ContentType = "text/html; charset=utf-8";
        context.Response.ContentLength = bytes.Length;
        context.Response.Headers.Remove("ETag");
        context.Response.Headers.Remove("Last-Modified");
        context.Response.Headers.Remove("Accept-Ranges");
        await originalBody.WriteAsync(bytes).ConfigureAwait(false);
    }

    private static bool IsWebShell(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return false;
        }

        return path.Equals("/web", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith("/web/", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith("/web/index.html", StringComparison.OrdinalIgnoreCase);
    }
}
