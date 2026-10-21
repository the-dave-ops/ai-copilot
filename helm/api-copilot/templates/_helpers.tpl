{{- define "api-copilot.name" -}}{{- .Chart.Name -}}{{- end -}}
{{- define "api-copilot.fullname" -}}{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}{{- end -}}
{{- define "api-copilot.labels" -}}
app.kubernetes.io/name: {{ include "api-copilot.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
