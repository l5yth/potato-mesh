# frozen_string_literal: true

require_relative "lib/potato_mesh/application"

PotatoMesh::Application.run! if $PROGRAM_NAME == __FILE__
