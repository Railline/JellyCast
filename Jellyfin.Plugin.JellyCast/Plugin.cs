using Jellyfin.Plugin.JellyCast.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.JellyCast;

/// <summary>The JellyCast plugin.</summary>
public sealed class Plugin : BasePlugin<PluginConfiguration>
{
    /// <summary>JellyCast's stable plugin identifier.</summary>
    public static readonly Guid PluginId = Guid.Parse("5e1ee9eb-d26b-47f0-b8e0-6cbe9cc3cc43");

    /// <summary>Initializes a new instance of the <see cref="Plugin"/> class.</summary>
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    /// <summary>Gets the active plugin instance.</summary>
    public static Plugin? Instance { get; private set; }

    /// <inheritdoc />
    public override string Name => "JellyCast";

    /// <inheritdoc />
    public override Guid Id => PluginId;

    /// <inheritdoc />
    public override string Description =>
        "Transfère la lecture en cours vers un autre appareil connecté au même compte.";
}

