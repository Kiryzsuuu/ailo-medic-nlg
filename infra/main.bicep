targetScope = 'resourceGroup'

@description('Base name for all resources (letters/numbers/hyphen).')
param namePrefix string = toLower(replace(resourceGroup().name, '_', '-'))

@description('Azure region for resources.')
param location string = resourceGroup().location

@description('App Service Plan SKU name (e.g. B1, P1v3).')
param appServicePlanSku string = 'B1'

@description('Unique web app name for Node service.')
param webAppName string = '${namePrefix}-web-${uniqueString(resourceGroup().id)}'

@description('Unique web app name for Python API service.')
param pyApiAppName string = '${namePrefix}-pyapi-${uniqueString(resourceGroup().id)}'

@description('OpenAI-compatible base URL (e.g. https://api.openai.com/v1).')
param openAiBaseUrl string = 'https://api.openai.com/v1'

@secure()
@description('OpenAI API key (set via azd env set or during deployment).')
param openAiApiKey string

@description('OpenAI model name (e.g. gpt-4o-mini).')
param openAiModel string

var planName = '${namePrefix}-plan'

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  sku: {
    name: appServicePlanSku
    tier: (appServicePlanSku == 'F1' ? 'Free' : (appServicePlanSku == 'B1' ? 'Basic' : 'PremiumV3'))
  }
  kind: 'linux'
  properties: {
    reserved: true
  }
}

resource web 'Microsoft.Web/sites@2023-12-01' = {
  name: webAppName
  location: location
  kind: 'app,linux'
  tags: {
    'azd-service-name': 'web'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|20-lts'
      appSettings: [
        {
          name: 'WEBSITE_NODE_DEFAULT_VERSION'
          value: '~20'
        }
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'true'
        }
        {
          name: 'OPENAI_BASE_URL'
          value: openAiBaseUrl
        }
        {
          name: 'OPENAI_API_KEY'
          value: openAiApiKey
        }
        {
          name: 'OPENAI_MODEL'
          value: openAiModel
        }
        {
          name: 'LOG_LEVEL'
          value: 'info'
        }
      ]
    }
  }
}

resource pyapi 'Microsoft.Web/sites@2023-12-01' = {
  name: pyApiAppName
  location: location
  kind: 'app,linux'
  tags: {
    'azd-service-name': 'pyapi'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'PYTHON|3.11'
      appCommandLine: 'gunicorn -k uvicorn.workers.UvicornWorker -w 2 -b 0.0.0.0:8000 app:app'
      appSettings: [
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'true'
        }
        {
          name: 'OPENAI_BASE_URL'
          value: openAiBaseUrl
        }
        {
          name: 'OPENAI_API_KEY'
          value: openAiApiKey
        }
        {
          name: 'OPENAI_MODEL'
          value: openAiModel
        }
        {
          name: 'OPENAI_TIMEOUT_S'
          value: '60'
        }
        {
          name: 'PORT'
          value: '8000'
        }
      ]
    }
  }
}

output webAppHostname string = web.properties.defaultHostName
output pyApiHostname string = pyapi.properties.defaultHostName
