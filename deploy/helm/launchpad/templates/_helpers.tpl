{{- define "launchpad.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "launchpad.fullname" -}}
{{- .Release.Name -}}
{{- end -}}

{{- define "launchpad.labels" -}}
app.kubernetes.io/name: {{ include "launchpad.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "launchpad.selectorLabels" -}}
app.kubernetes.io/name: {{ include "launchpad.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "launchpad.secretName" -}}
{{- if .Values.existingSecretName -}}
{{- .Values.existingSecretName -}}
{{- else -}}
{{- include "launchpad.fullname" . -}}
{{- end -}}
{{- end -}}
