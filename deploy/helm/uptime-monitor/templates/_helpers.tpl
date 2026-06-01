{{- define "uptime-monitor.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "uptime-monitor.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "uptime-monitor.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "uptime-monitor.labels" -}}
app.kubernetes.io/name: {{ include "uptime-monitor.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "uptime-monitor.dbSecretName" -}}
{{- if .Values.database.existingSecret -}}
{{- .Values.database.existingSecret -}}
{{- else -}}
{{- printf "%s-db" (include "uptime-monitor.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "uptime-monitor.dbSecretKey" -}}
{{- if .Values.database.existingSecret -}}
{{- .Values.database.existingSecretKey -}}
{{- else -}}
DATABASE_URL
{{- end -}}
{{- end -}}

{{- define "uptime-monitor.cronSecretName" -}}
{{- printf "%s-cron" (include "uptime-monitor.fullname" .) -}}
{{- end -}}
