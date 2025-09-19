# Potato Mesh Agent Guidelines

## Build/Lint/Test Commands

### Python (data/ directory)
- **Lint**: `black --check ./`
- **Test**: `pytest --cov=data --cov-report=term --cov-report=xml:reports/python-coverage.xml --junitxml=reports/python-junit.xml`
- **Test single file**: `pytest tests/test_mesh.py::test_function_name -v`
- **Format**: `black ./`

### Ruby (web/ directory)
- **Install dependencies**: `bundle install`
- **Lint**: `bundle exec rufo --check .`
- **Test**: `bundle exec rspec --require rspec_junit_formatter --format progress --format RspecJunitFormatter --out tmp/test-results/rspec.xml`
- **Test single file**: `bundle exec rspec spec/app_spec.rb -v`
- **Format**: `bundle exec rufo .`

## Code Style Guidelines

### Python
- Use type hints for function parameters and return values
- Use dataclasses for simple data structures
- Write comprehensive docstrings with Args/Returns sections
- Handle exceptions gracefully with specific exception types
- Use descriptive variable names (snake_case)
- Import modules at the top, group by standard library, third-party, local
- Use f-strings for string formatting
- Follow PEP 8 conventions
- Use environment variables for configuration
- Log debug information conditionally based on DEBUG flag

### Ruby
- Use `frozen_string_literal: true` at the top of all files
- Write comprehensive method documentation with parameter descriptions
- Use descriptive method names (snake_case)
- Handle exceptions with rescue blocks and proper error responses
- Use Sinatra's built-in helpers and conventions
- Implement proper authentication and authorization
- Use environment variables for configuration
- Follow Ruby naming conventions (classes in CamelCase)
- Use proper HTTP status codes and JSON error responses
- Implement retry logic for database operations
- Use Rack::Utils.secure_compare for secure string comparison

### General
- Include Apache 2.0 license headers on all source files
- Use environment variables for all configuration
- Implement proper error handling and logging
- Write comprehensive tests for all functionality
- Use secure coding practices (SQL injection prevention, secure token comparison)
- Follow separation of concerns principles
- Use descriptive commit messages
- Test both success and failure scenarios

## Dependencies

### Python
- meshtastic>=2.0.0 (production)
- protobuf>=4.21.12 (production)
- black>=23.0.0 (development)
- pytest>=7.0.0 (development)

### Ruby
- sinatra ~> 4.0 (production)
- sqlite3 ~> 1.7 (production)
- rackup ~> 2.2 (production)
- puma ~> 7.0 (production)
- rspec ~> 3.12 (test)
- rack-test ~> 2.1 (test)
- rufo ~> 0.18.1 (test)
- simplecov ~> 0.22 (test)

## Testing Strategy
- Use pytest for Python unit tests with comprehensive mocking
- Use RSpec for Ruby integration tests with fixture data
- Test error conditions and edge cases
- Use test doubles/stubs for external dependencies
- Generate coverage reports for both languages
- Test authentication and authorization thoroughly
- Test database operations including retry logic
- Use descriptive test names and organize tests by functionality

## Security Considerations
- Use parameterized queries to prevent SQL injection
- Implement proper authentication with bearer tokens
- Use secure token comparison methods
- Validate and sanitize all input data
- Implement rate limiting and payload size limits
- Log security-relevant events appropriately
- Use environment variables for sensitive configuration