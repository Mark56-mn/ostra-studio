# Ostra Studio — Agent Contracts

## Purpose

This document defines how production workers interact with Ostra. It is a contract, not a prompt.

## General worker contract

Every worker must expose:

- identity
- worker type
- provider
- model
- runtime
- health/status
- capabilities
- current task
- last heartbeat
- error state where applicable

Every task response must identify:
- task id
- status
- artifacts produced
- structured metadata
- error information if failed

## Script Worker

Input:
- project/story context
- episode context
- requested task
- relevant previous artifacts

Output may include:
- story updates
- episode outline
- script
- scene specifications
- narration
- image specifications
- structured decisions

It must not directly mutate unrelated production state.

## Image Worker

Input:
- scene specification
- character/location references
- visual style
- generation settings

Output:
- image artifact(s)
- provider/model metadata
- generation parameters where safe
- version information

## Voice Worker

Input:
- narration/dialogue segment
- selected voice
- language
- provider settings

Output:
- audio artifact
- duration
- provider/model metadata
- version information

Initial provider target: Kokoro-82M.

## Renderer

Input:
- ordered scene assets
- audio
- subtitle/timing information
- production settings

Output:
- video artifact
- render metadata
- validation information

Renderer must be deterministic where practical.

## YouTube Worker

Input:
- approved video
- title
- description
- thumbnail
- publishing settings

Output:
- YouTube video id
- upload/publish status
- timestamps
- returned URL when available

It must refuse/stop when approval is absent.

## Message rules

Messages should be:
- task-scoped
- structured
- attributable
- timestamped
- persisted when important

Do not use hidden direct agent-to-agent channels that bypass the orchestrator.

## Operational reasoning

Expose concise operational rationale, decisions, and actions.

Do not expose private hidden chain-of-thought.

## Provider replacement

The workflow must depend on capability contracts, not provider-specific behavior.

For example:
`generate_voice()` is a capability; Kokoro and ElevenLabs are implementations.
