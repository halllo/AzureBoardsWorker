#:sdk Microsoft.NET.Sdk
#:property TargetFramework=net10.0
#:property ImplicitUsings=enable
#:property Nullable=enable
#:package Microsoft.Identity.Web@4.11.0
#:package Microsoft.Identity.Web.AgentIdentities@4.11.0
#:package Microsoft.Identity.Web.TokenCache@4.11.0

using System.Security.Claims;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Identity.Abstractions;
using Microsoft.Identity.Web;
using Microsoft.Identity.Web.TokenCacheProviders.InMemory;

var host = Host.CreateDefaultBuilder(args)
    .ConfigureLogging(logging => logging.ClearProviders())
    .ConfigureServices((_, services) =>
    {
        services.AddTokenAcquisition(isTokenAcquisitionSingleton: true)
            .Configure<MicrosoftIdentityApplicationOptions>(options =>
            {
                options.Instance = "https://login.microsoftonline.com/";
                options.TenantId = RequiredEnvironmentVariable("ENTRA_TENANT_ID");
                options.ClientId = RequiredEnvironmentVariable("ENTRA_AGENT_BLUEPRINT_ID");
                options.ClientCredentials =
                [
                    new CredentialDescription
                    {
                        SourceType = CredentialSource.ClientSecret,
                        ClientSecret = RequiredEnvironmentVariable("ENTRA_AGENT_BLUEPRINT_SECRET"),
                    },
                ];
            })
            .AddInMemoryTokenCaches()
            .AddHttpClient()
            .AddAgentIdentities();
    })
    .Build();

var agentIdentityId = RequiredEnvironmentVariable("ENTRA_AGENT_IDENTITY");
var agentUserId = Guid.Parse(RequiredEnvironmentVariable("ENTRA_AGENT_USER_ID"));
var authorizationHeaderProvider = host.Services.GetRequiredService<IAuthorizationHeaderProvider>();
var options = new AuthorizationHeaderProviderOptions().WithAgentUserIdentity(agentIdentityId, agentUserId);
var header = await authorizationHeaderProvider.CreateAuthorizationHeaderForUserAsync(
    ["https://app.vssps.visualstudio.com/.default"],
    options,
    new ClaimsPrincipal());

Console.Out.Write(header["Bearer ".Length..]);

static string RequiredEnvironmentVariable(string name)
{
    var value = Environment.GetEnvironmentVariable(name) ?? ReadDotEnvValue(name);
    return !string.IsNullOrEmpty(value)
        ? value
        : throw new InvalidOperationException($"set {name} in .env");
}

static string? ReadDotEnvValue(string name)
{
    var dotenvPath = Path.Combine(Environment.CurrentDirectory, ".env");
    if (!File.Exists(dotenvPath)) return null;

    foreach (var line in File.ReadLines(dotenvPath))
    {
        var separator = line.IndexOf('=');
        if (separator < 1 || line[..separator].Trim() != name) continue;

        var value = line[(separator + 1)..].Trim();
        if (value.Length >= 2 && value[0] == value[^1] && (value[0] == '\'' || value[0] == '"'))
        {
            value = value[1..^1];
        }
        return value;
    }

    return null;
}